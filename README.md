# @imenam/mcp-dependabot-tracker

Suivi des alertes Dependabot de dépôts GitHub, et correction de leurs vulnérabilités npm dans un clone temporaire, depuis une interface web ou par un agent.

Pour chaque dépôt suivi, l'interface montre les alertes Dependabot ouvertes et lance une **correction**, menée de bout en bout sans intervention : clone temporaire de la branche choisie pour le dépôt (la branche par défaut tant qu'aucune autre n'est choisie), `npm audit`, `npm audit fix`, corrections par Claude s'il reste des vulnérabilités, puis commit sur une nouvelle branche, push et pull request.

Le paquet s'utilise de deux façons, qui ne se recouvrent pas :

- **le serveur** (`serve`) : un processus de longue durée, lancé comme un service, qui porte l'interface, les données, la relecture périodique des alertes et toutes les opérations ;
- **le mode MCP** (`mcp`) : lancé par un agent, il expose des outils qui pilotent ce serveur par son API, avec un token d'agent. Il ne fait aucun travail lui-même et n'a pas d'autre réglage que l'adresse du serveur et le token.

```
Utilisateur ──navigateur──▶ ┌──────────────────────────┐ ──API GitHub──▶ alertes, PR
                            │   Serveur (serve)        │ ──git, npm───▶ clones temporaires
Agent ──stdio──▶ mode MCP ──│   interface, API,        │ ──claude -p──▶ corrections par Claude
           (npx … mcp)  HTTP│   opérations, relecture  │ ──API──────▶ organizer
                     + token└──────────────────────────┘
```

L'agent fait ce que fait l'utilisateur pour les corrections : il liste les dépôts, lance des audits et des corrections, corrections par Claude comprises, les suit et les annule. Il n'exécute jamais `git` ni `npm` lui-même. Les réglages, les catégories, la file d'attente et les tokens restent dans l'interface. Quand `npm audit fix` laisse des vulnérabilités, une correction fait **corriger par Claude** (Claude Code, avec un abonnement Claude) : il analyse chaque vulnérabilité dans le code, corrige ce qu'il peut dans un commit séparé, et rend compte de son travail dans une seule tâche d'un [organizer](https://www.npmjs.com/package/@imenam/mcp-organizer) (voir [Les corrections par Claude](#les-corrections-par-claude)).

---

## Installation

### Le serveur

```bash
npm install -g @imenam/mcp-dependabot-tracker
mcp-dependabot-tracker serve
```

Ou via `npx -y @imenam/mcp-dependabot-tracker serve`. Le serveur se lance comme un service (systemd, conteneur…) : il tourne en continu, que des agents soient connectés ou non, et une correction en cours survit à la fermeture de l'agent qui l'a lancée. `git` et `npm` (npm 7 ou plus récent) doivent être dans le `PATH` de la machine qui l'exécute, ainsi que bubblewrap sous Linux (`sudo apt-get install -y bubblewrap socat`) : toutes les commandes npm d'une opération y tournent en bac à sable. Claude Code, utilisé par les corrections par Claude, est une dépendance du package (`@anthropic-ai/claude-code`, Node 22 ou plus récent) : rien d'autre à installer.

Le serveur exige une clé de coffre, `VAULT_KEY`, qui chiffre les clés privées SSH des serveurs de déploiement. Générez-la une fois et déclarez-la comme variable secrète du service :

```bash
npx -y @imenam/mcp-dependabot-tracker --generate-vault-key
```

Le serveur journalise sur sa sortie d'erreur et dans `<logs>/server.log` ; au démarrage, il donne l'adresse de son interface. Un répertoire de données ne sert qu'à un serveur à la fois.

### Exposition et authentification

Le serveur est une application autonome : il sert lui-même l'interface à l'adresse `APP_URL`, sur le port `APP_PORT`.

- **L'interface et son API** exigent une session ouverte avec un compte e-mail et mot de passe ([Better Auth](https://www.better-auth.com)). Les sessions durent 7 jours, sont prolongées à l'usage et vivent dans un cookie `HttpOnly`, `SameSite=Lax`, `Secure` en https. Les tentatives de connexion sont limitées à 5 par minute et par client, toutes les requêtes d'authentification à 100 par minute. Une requête de modification venue d'un autre site est refusée (`Sec-Fetch-Site`, à défaut `Origin`).
- **L'API des agents** (`/api/agent/…`) exige un token d'agent (`Authorization: Bearer dtk_…`), et rien d'autre.

`APP_URL` est en https, sauf sur `localhost` : avec `http://localhost:<port>`, le serveur n'écoute que sur `127.0.0.1` ; avec une adresse https, il écoute sur toutes les interfaces, derrière le reverse proxy qui porte le certificat (Caddy, nginx…). Dans ce cas, déclarez l'adresse du reverse proxy dans `TRUSTED_PROXIES` : le limiteur de débit identifie alors le client par `X-Forwarded-For`, et non par l'adresse du proxy. Sans `TRUSTED_PROXIES`, `X-Forwarded-For` est ignoré.

Exemple avec Caddy, qui obtient le certificat tout seul :

```
deps.example.com {
	reverse_proxy 127.0.0.1:4700
}
```

```bash
APP_URL=https://deps.example.com
APP_PORT=4700
TRUSTED_PROXIES=127.0.0.1
```

### Comptes de l'interface

Il n'y a pas d'inscription : les comptes se créent sur la machine du serveur, avec le même environnement que lui (`MCP_DATA_DIR`, `APP_URL`, `AUTH_SECRET`, ou le `.env` du package). Le mot de passe est demandé deux fois, sans être affiché ; il fait au moins 12 caractères.

```bash
mcp-dependabot-tracker user add admin@example.com --name="Admin"
mcp-dependabot-tracker user password admin@example.com
mcp-dependabot-tracker user totp admin@example.com
mcp-dependabot-tracker user remove admin@example.com
mcp-dependabot-tracker user list
```

Changer le mot de passe ou supprimer le compte ferme aussitôt ses sessions. Sans terminal, le mot de passe est lu sur la première ligne de l'entrée standard. Tant qu'aucun compte n'existe, le serveur le signale au démarrage. Comptes et sessions sont enregistrés dans `<données>/auth.sqlite`.

**Double authentification** — un compte ouvre l'exécution de scripts sur les serveurs de déploiement : protégez-le par un second facteur. `user totp <email>` affiche la clé à saisir dans une application d'authentification (TOTP, six chiffres, 30 s), son adresse `otpauth://` et dix codes de secours à usage unique, puis demande le code affiché par l'application : la double authentification n'est activée qu'avec un code juste, et les sessions du compte sont alors fermées. Sans terminal, elle est activée sans cette vérification. La connexion se fait ensuite en deux étapes : e-mail et mot de passe, puis le code de l'application ou un code de secours ; le mot de passe seul n'ouvre aucune session. Cinq codes faux ferment la vérification en cours, dix d'affilée verrouillent le compte un quart d'heure. Relancer `user totp <email>` remplace la clé et les codes de secours ; `user totp <email> --remove` retire la double authentification. `user list` indique pour chaque compte s'il l'a activée, et le serveur signale au démarrage ceux qui ne l'ont pas.

`AUTH_SECRET` signe les sessions et chiffre les clés TOTP. Générez-le une fois et déclarez-le comme variable secrète du service ; le changer ferme toutes les sessions et rend les clés TOTP illisibles (relancez alors `user totp` pour chaque compte) :

```bash
npx -y @imenam/mcp-dependabot-tracker --generate-auth-secret
```

### Le mode MCP, dans un projet

Dans l'interface du serveur, écran Réglages, section « Accès des agents », « Nouveau token » crée un token et affiche la commande à lancer dans le projet :

```bash
npx -y @imenam/mcp-dependabot-tracker --claude-setup-mcp --server_url=http://localhost:4700 --token=dtk_…
```

La commande crée (ou complète) le `.mcp.json` du répertoire courant avec une entrée `mcp-dependabot-tracker`. `--force` remplace une entrée existante ; les autres serveurs sont préservés. `--server_url` et `--token` sont obligatoires.

```json
{
  "mcpServers": {
    "mcp-dependabot-tracker": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-dependabot-tracker", "mcp"],
      "env": {
        "SERVER_URL": "http://localhost:4700",
        "AGENT_TOKEN": "dtk_…"
      }
    }
  }
}
```

`SERVER_URL` est l'adresse publique du serveur, `APP_URL`. Le mode MCP appelle `<SERVER_URL>/api/agent/…` avec l'en-tête `Authorization: Bearer <token>` : l'adresse doit joindre le serveur sans autre authentification. Sans `SERVER_URL` ou `AGENT_TOKEN`, le mode MCP refuse de démarrer.

### Token GitHub

Un token à grain fin, limité aux dépôts suivis, avec les permissions :

| Permission | Accès | Pour |
|---|---|---|
| Dependabot alerts | lecture | lire les alertes |
| Contents | lecture et écriture | cloner, pousser la branche de correction |
| Pull requests | lecture et écriture | ouvrir la pull request, suivre celles qui attendent d'être mergées |
| Metadata | lecture | imposée par GitHub ; liste les dépôts proposés à l'ajout |

Un token classique convient aussi, avec les scopes `repo` et `security_events`. Les commits sont signés du compte du token, avec son adresse `noreply` GitHub. Le token est transmis à `git` par un en-tête HTTP (`http.<serveur>/.extraheader`, dans l'environnement de la commande) : il n'est écrit ni dans le clone ni dans la ligne de commande. Les commandes `git` et `npm` ne reçoivent du serveur que ses variables système (`PATH`, `HOME`, langue, dossiers temporaires, proxy et certificats) : ni `GITHUB_TOKEN`, ni `VAULT_KEY`, ni `AUTH_SECRET`, ni aucune autre variable du service.

### Variables d'environnement du serveur

Elles se renseignent dans l'environnement du service, ou dans un fichier `.env` à la racine du package, qui prime.

| Variable | Rôle |
|---|---|
| `GITHUB_TOKEN` | **Obligatoire.** Token GitHub (voir ci-dessus). Sans lui, le serveur refuse de démarrer. |
| `CLONE_DIR` | **Obligatoire.** Dossier où chaque opération crée son clone ; il est créé s'il n'existe pas. Sans lui, le serveur refuse de démarrer. |
| `VAULT_KEY` | **Obligatoire.** 32 octets en base64 (`--generate-vault-key`), qui chiffrent en AES-256-GCM les clés privées des serveurs de déploiement. Sans elle, ou si elle ne déchiffre pas les clés déjà enregistrées, le serveur refuse de démarrer. La perdre oblige à reconnecter chaque serveur. |
| `APP_PORT` | **Obligatoire.** Port d'écoute du serveur. |
| `APP_URL` | **Obligatoire.** Adresse publique de l'interface, sans chemin : `https://…`, ou `http://localhost:<port>` sur la machine elle-même (voir [Exposition et authentification](#exposition-et-authentification)). |
| `AUTH_SECRET` | **Obligatoire.** Secret de signature des sessions, 32 caractères au moins (`--generate-auth-secret`). |
| `TRUSTED_PROXIES` | Adresses IP ou plages CIDR des reverse proxies, séparées par des virgules, dont l'en-tête `X-Forwarded-For` est cru. |
| `GITHUB_API_URL` | API GitHub (défaut `https://api.github.com`), à changer pour GitHub Enterprise Server. |
| `GITHUB_SERVER_URL` | Serveur git des clones (défaut `https://github.com`) : un dépôt se clone depuis `<serveur>/<propriétaire>/<nom>.git`. |
| `MCP_DATA_DIR` | Répertoire des données (défaut `~/.mcp-dependabot-tracker`). Hors de Windows, le serveur le réserve à son compte (droits `700`) à chaque démarrage, et ses fichiers sont écrits en `600`. |
| `MCP_LOG_DIR` | Répertoire des logs. Défaut : `<données>/logs`. |

Sans une variable obligatoire, ou avec une valeur invalide (`APP_URL` en http hors `localhost`, `AUTH_SECRET` trop court), le serveur refuse de démarrer en nommant la variable.

### Dans mcp-http-gateway

Le mode MCP se déclare dans un gateway ([mcp-http-gateway](https://www.npmjs.com/package/@imenam/mcp-http-gateway)) comme tout autre MCP, dans `config/mcp-servers.json` :

```json
{
  "mcpServers": {
    "dependabot-tracker": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-dependabot-tracker", "mcp"],
      "env": {
        "MCP_SERVER_ROUTE": "/dependabot-tracker",
        "SERVER_URL": "http://localhost:4700",
        "AGENT_TOKEN": "dtk_…"
      }
    }
  }
}
```

Le gateway n'héberge que le mode MCP : clones, `npm`, Claude Code et appels à GitHub ont lieu sur la machine du serveur, qui doit joindre GitHub et le registre npm. Aucune route d'exécution (`GATEWAY_EXEC_ROUTES`) n'est nécessaire côté agent.

---

## Les outils

Six outils, en anglais, servis par le mode MCP. Le compte rendu d'une opération se termine par le lien vers son écran dans l'interface.

| Outil | Effet |
|---|---|
| `list_repositories` | Dépôts suivis non dépréciés, tous ou ceux d'une catégorie (`category`, son nom) : catégorie, alertes Dependabot ouvertes par gravité (hors celles que l'utilisateur a corrigées à la main, comptées à part), paquets sans version corrigée au dernier audit, dernier audit sans vulnérabilité qui contredit les alertes, vulnérabilités trouvées par le dernier audit de la branche par défaut quand Dependabot ne signale rien, date de la dernière lecture (et son erreur), pull requests du tracker pas encore mergées, opération en cours. |
| `get_alerts` | Relit sur GitHub les alertes ouvertes d'un dépôt (`repository`) et les liste de la plus grave à la moins grave : numéro, gravité, paquet, écosystème, manifeste, portée de la dépendance (exécution ou développement), résumé, version corrigée, marque « corrigée à la main » de l'utilisateur, lien. |
| `run_audit` | Lance `npm audit` dans un clone temporaire de la branche analysée, sur le périmètre `scope` (`production` par défaut, ou `all`). Rien n'est modifié. Rend aussitôt l'identifiant de l'opération. |
| `fix_vulnerabilities` | Lance la même correction que le bouton « Corriger » de l'interface, sur le périmètre `scope` : `npm audit`, `npm audit fix`, corrections par Claude s'il reste des vulnérabilités, puis commit, push et pull request vers la branche analysée. Avec `claude: false`, les corrections par Claude sont passées et seules celles de `npm audit fix` sont poussées. Rend aussitôt l'identifiant de l'opération. |
| `get_operation` | État d'une opération (`operation`) : en cours, terminée, échouée ou annulée ; l'étape en cours (et, pendant les corrections par Claude, ses tours et ses dernières actions), les vulnérabilités avant et après, les paquets mis à jour, le résumé des corrections par Claude, leurs tests et leur tâche, la pull request, l'erreur. |
| `cancel_operation` | Annule une opération en cours (`operation`) : sa commande s'arrête, Claude Code compris, le clone est supprimé et rien n'est poussé. |

Un dépôt déprécié est refusé par tous les outils, jusqu'à ce que l'utilisateur le rétablisse. Un champ inconnu fait échouer l'appel. L'agent ne peut ni ajouter ni retirer de dépôt. Un token révoqué ferme aussitôt l'accès : chaque outil le dit.

---

## Une opération

Chaque opération travaille dans un clone temporaire (`<CLONE_DIR>/mcp-dependabot-tracker-*/repo`, `git clone --depth 1` de la branche analysée), supprimé dès qu'elle se termine, réussie, échouée ou annulée.

La **branche analysée** se choisit par dépôt dans la GUI ; c'est la branche par défaut tant qu'aucune autre n'est choisie. L'agent l'utilise aussi, sans pouvoir en changer. Les alertes Dependabot, elles, portent toujours sur la branche par défaut, la seule que GitHub analyse : sur une autre branche, c'est `npm audit` qui mesure les vulnérabilités.

Le **périmètre** se choisit à chaque lancement d'une correction, d'un audit ou de « Auditer tout » : **production** (par défaut) ajoute `--omit=dev` à `npm audit` et `npm audit fix`, qui laissent alors les devDependencies de côté ; **toutes les dépendances** les couvre aussi. Chaque alerte Dependabot porte la portée de sa dépendance (`dependency.scope` de l'API GitHub : exécution ou développement). Un audit de production ne se compare qu'aux alertes qui ne portent pas sur une dépendance de développement ; une alerte de portée inconnue compte comme une alerte de production. Une opération enregistrée avant ce choix est lue comme un audit de toutes les dépendances.

1. **Cloner le dépôt** — puis repérer les projets npm : chaque dossier dont le `package-lock.json` est suivi par git (racine, `gui/`…). Un dépôt sans lockfile fait échouer l'opération : `npm audit` en a besoin. Un lockfile v1 (npm 6) est refusé.
2. **npm audit** — `npm audit --json` dans chaque projet, avec `--omit=dev` en production.
3. **npm audit fix** — `npm audit fix --package-lock-only --ignore-scripts` dans chaque projet vulnérable : seuls les lockfiles changent, sans installation de `node_modules` ni script de paquet. Puis un nouvel audit. Les commandes npm du tracker reçoivent `npm_config_allow_remote=all` : avec `--package-lock-only`, npm 12 refuse sinon les archives des paquets à `bundleDependencies` comme `@tailwindcss/oxide-wasm32-wasi` ([npm/cli#9800](https://github.com/npm/cli/issues/9800)). Ce réglage ne vaut que pour ces commandes, pas pour la configuration npm de la machine.
4. **Corrections par Claude** — pour une correction, dès que des vulnérabilités restent : la branche `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>` (heure locale du serveur) est créée, les lockfiles de `npm audit fix` y sont commités, puis Claude analyse et corrige en une session (voir [Les corrections par Claude](#les-corrections-par-claude)). Passées quand rien ne reste, et quand l'agent lance la correction avec `claude: false`. Un échec, Claude non configuré compris, laisse la correction se poursuivre avec les seules corrections de `npm audit fix`.
5. **Commit et push** — commit des fichiers modifiés sur la branche `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>`, push, puis pull request vers la branche analysée, titrée du message de commit par défaut. Après les corrections par Claude, la branche porte déjà ses commits : seuls le push et la pull request restent à faire. Le corps de la pull request donne le périmètre et la commande exacte, les vulnérabilités avant et après, les paquets mis à jour et, le cas échéant, le résumé des corrections par Claude, fichier par fichier, avec le résultat des tests et la clé de sa tâche. Un avertissement en tête signale l'échec de Claude (la pull request ne porte alors que les corrections de `npm audit fix`) ou des tests en échec après ses corrections.

**Pull requests en attente** — à chaque lecture d'un dépôt (toutes les 10 minutes, ou « Synchroniser maintenant »), le tracker lit ses pull requests ouvertes sur GitHub et garde celles dont la branche suit le nommage `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>` et appartient au dépôt lui-même (pas à une fourche). Les pull requests ouvertes avant cette fonction sont donc reconnues, même quand l'historique des opérations ne les contient plus. Une pull request mergée ou fermée disparaît à la lecture suivante, ou aussitôt quand l'utilisateur la marque mergée dans l'onglet « PR en attente » ; une pull request que le tracker vient d'ouvrir apparaît aussitôt.

**Auditer tout** — depuis l'accueil, un audit seul (clone et `npm audit`, sans correction) de la **branche par défaut** de chaque dépôt suivi de l'onglet affiché : tous les dépôts sur « Tous mes projets » et « Dépréciés », ceux de la catégorie quand une catégorie est affichée (le bouton s'intitule alors « Auditer la catégorie »), ceux de la file d'attente sur son onglet (« Auditer la file »), quelle que soit sa branche analysée : c'est la branche que Dependabot analyse, et la seule sur laquelle les deux se comparent. Trois audits tournent à la fois. Un dépôt où une opération est déjà en cours est laissé de côté ; un audit qui échoue (dépôt sans `package-lock.json`, clone impossible) n'arrête pas les autres. La série vit dans le serveur ; une seule à la fois.

Les paquets mis à jour sont lus en comparant chaque lockfile à celui du commit cloné : version changée, paquet ajouté ou retiré. S'il n'y a rien à corriger, ou si les corrections ne changent rien, l'opération se termine sans push.

Depuis l'interface comme pour l'agent, une opération se lance aussitôt et va d'un bout à l'autre sans attendre de décision, dans le serveur, qu'on la suive ou non. Une seule opération à la fois par dépôt.

**Annulation** — l'annulation d'une opération en cours arrête aussitôt sa commande (arbre de processus compris, Claude Code compris) et supprime le clone ; rien n'est poussé. Une opération que l'arrêt du serveur a interrompue passe en échec au démarrage suivant, et son clone est supprimé.

---

## Les corrections par Claude

Quand `npm audit fix` laisse des vulnérabilités dans une correction, lancée depuis l'interface ou par un agent qui n'a pas passé `claude: false`, le tracker enchaîne sans attendre :

1. il crée la branche `fix/npm-audit-…` et y commite les lockfiles modifiés par `npm audit fix` (premier commit, avec le message par défaut), s'ils ont changé ;
2. il lance une session Claude Code non interactive (`claude -p`) dans le clone, avec les vulnérabilités restantes (extraites de `npm audit --json`). Claude analyse chaque vulnérabilité dans le code (usage du paquet, faille atteignable ou non, urgence), monte ou épingle les dépendances (`package.json`, entrées `overrides`, puis mise à jour du lockfile), adapte le code, relance `npm audit`, installe les dépendances (`npm ci`) et lance les tests, par les outils npm du tracker ;
3. Claude crée **une seule tâche** « Rapport de correction — … » dans l'espace organizer réglé, assignée au propriétaire de l'espace et taguée du nom du dépôt : son unique rapport, en français, avec l'analyse de chaque paquet vulnérable, chaque changement fichier par fichier et sa raison, le résultat de l'audit et des tests (un avertissement en tête quand ils échouent), et ce qui reste à corriger ou à vérifier à la main. Il rend un rapport structuré (`--json-schema`) : clé de la tâche, résumé, fichiers modifiés, message de commit, résultat des tests ;
4. le tracker vérifie la tâche (assignée, taguée), commite les changements de Claude (second commit, au message proposé par Claude, avec `Co-Authored-By: Claude`), sans les `node_modules`, relance `npm audit`, puis pousse la branche et ouvre la pull request.

Une tâche introuvable, sans le tag ou non assignée au propriétaire fait échouer la session, comme une erreur de Claude, un dépassement des limites, l'organizer ou le token Claude non réglés, ou un bac à sable impossible : le clone revient au commit de `npm audit fix`, l'erreur s'affiche sous l'étape, et la correction pousse quand même les corrections de `npm audit fix`, avec un avertissement en tête de la pull request. L'annulation de l'opération arrête Claude Code.

**Ce que Claude peut faire** — outils intégrés `Read`, `Grep`, `Glob`, `Edit` et `Write`, sans shell : ni `git`, ni push. `Edit` et `Write` refusent tout chemin hors du clone (`blockWritesOutsideWorkingDirectories`). Le clone n'a pas de dossier `.git` : le dépôt git de l'opération est à côté de lui (`GIT_DIR`), hors de portée de Claude et des commandes npm, et le tracker lance `git` sans hook (`core.hooksPath`) ni moniteur de fichiers (`core.fsmonitor`) ; un hook posé dans le clone par un paquet (husky…) ou par un script d'installation ne s'exécute donc jamais sur le serveur. Claude lance npm par les outils d'un second serveur MCP, `npm`, que le tracker lui fournit (`dist/src/npm-tools.js`) : `npm_install_lockfile` (`npm install --package-lock-only --ignore-scripts`, avec les paquets à ajouter ou monter), `npm_audit` (avec le périmètre de l'opération), `npm_ci`, `npm_test`, `npm_run` (un script de `package.json`), `npm_ls` et `tsc` (`npm exec --no -- tsc --noEmit`). Chaque outil lance une commande fixe dans un dossier du clone qui contient un `package.json` ; ses arguments ne sont que des noms de paquets ou de scripts. Le bac à sable de Claude Code garde en lecture seule les manifestes, les lockfiles et `node_modules` : ces commandes tournent donc hors de lui, dans un bac à sable **bubblewrap** du tracker, le même que celui où le tracker lance ses propres `npm audit` et `npm audit fix` : le contenu du dépôt (`.npmrc` compris) n'agit jamais hors de lui. Seul le système y est visible, en lecture seule : `/usr`, Node.js, et de `/etc` les seuls fichiers utiles au réseau, aux comptes et aux certificats (`resolv.conf`, `hosts`, `passwd`, `ssl`…), ni `/opt`, ni `/home`, ni le reste de `/etc` ; le clone et le cache npm de l'opération y sont en écriture, `/tmp` est vide, et l'environnement se réduit à `PATH`, `LANG`, `HOME`, au cache npm et à `CI=true` : ni les données du tracker, ni les autres clones, ni aucun token. Le réseau reste ouvert pour `npm ci`. Hors de Linux, ces commandes tournent directement dans le clone. Claude Code ne reçoit jamais `GITHUB_TOKEN`, et `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` retire son propre token de l'environnement des processus qu'il lance ; sous Linux, Claude Code exige alors lui aussi bubblewrap. Installez-le sur le serveur (`sudo apt-get install -y bubblewrap socat`). Au début de chaque opération et avant chaque session de Claude, le tracker crée un bac à sable d'essai avec le compte et les restrictions du serveur ; s'il échoue, l'opération ou la session est refusée avec la raison : `bwrap` absent, restriction AppArmor des espaces de noms utilisateur (`kernel.apparmor_restrict_unprivileged_userns`, Ubuntu 24.04 et suivantes) ou durcissement du service (`RestrictNamespaces`, `PrivateUsers`, `SystemCallFilter`). Côté organizer, seuls `create_task`, `set_assignees`, `set_tags` et `get_task` sont autorisés ; tout autre appel est refusé (`--permission-mode dontAsk`), et les réglages Claude du dépôt cloné ne sont pas lus (`--setting-sources user`). Installer les dépendances et lancer les tests exécute le code du projet et de ses paquets dans le clone, à chaque correction par Claude. La configuration MCP, qui porte le token de l'organizer, est écrite hors du clone et supprimée en fin de session.

**Limites** — nombre de tours (`--max-turns`, défaut 40) et durée (défaut 15 min, au-delà de laquelle le tracker arrête Claude Code), réglables dans la GUI.

**Réglages** (écran Réglages, roue dentée de l'accueil) :

- **Organizer** — adresse du site (https, sauf pour un site de cette machine) et token d'agent, créé dans l'organizer (Paramètres › Agents) : il couvre un espace, avec les droits de son créateur. Une connexion modifiée est testée à l'enregistrement ; « Tester » la reteste. L'écran affiche l'espace et son propriétaire.
- **Claude** — un token d'abonnement (Pro, Max, Team ou Enterprise) : lancer `claude setup-token` sur un poste avec navigateur, autoriser l'accès, puis coller le token affiché (valable un an). Il est vérifié à l'enregistrement par une requête minimale ; un token refusé n'est pas enregistré. L'écran affiche sa date d'enregistrement et d'expiration.
- **Corrections par Claude** — les limites d'une session.
- **Accès des agents** — les tokens d'agent, un par ligne : nom, quatre derniers caractères, date de création et de dernière utilisation ; « Révoquer », au survol (en permanence sur un écran tactile), le révoque après un second clic de confirmation dans les 4 secondes. « Nouveau token » ouvre un champ en place pour le nommer (Entrée crée, Échap annule) ; le token s'affiche alors une seule fois, avec « Copier » et la commande `--claude-setup-mcp` qui déclare le mode MCP. Créer ou révoquer un token prend effet aussitôt, sans « Enregistrer ».

Les tokens de l'organizer et de Claude sont enregistrés dans `<données>/settings.json`, ceux des agents par leur empreinte dans `<données>/agent-tokens.json`, lisibles par le seul compte du serveur ; la GUI n'en reçoit que les quatre derniers caractères. Claude Code garde sa configuration dans `<données>/claude`. L'écran est protégé comme le reste de l'interface, par la session de l'utilisateur.

**Suivi** — la tâche du dernier rapport de Claude s'affiche dans la colonne « Suivi » de la ligne du dépôt (« MNT-12 », qui ouvre la tâche sur l'organizer) tant qu'elle n'est pas terminée : son statut est relu sur l'organizer avec les alertes, toutes les 10 minutes. La pull request de la correction mentionne la clé de la tâche.

---

## Le déploiement

Chaque dépôt peut se déployer sur un serveur, par SSH, avec un script shell écrit dans l'interface (onglet « Déploiement » de l'écran du dépôt).

**Connexion d'un serveur** — la même procédure que dans [SSH Gate](https://www.npmjs.com/package/@imenam/mcp-ssh-gate), en trois étapes :

1. **Serveur** — nom, hôte, port et utilisateur. « Générer la clé » enregistre le serveur avec sa propre paire ed25519 (`dependabot-tracker@<serveur>`) et l'attache au dépôt. La clé privée est chiffrée avec `VAULT_KEY` et n'est jamais affichée.
2. **Installation** — une commande d'une ligne, à coller dans une session ouverte sur le serveur avec l'utilisateur choisi. Elle écrit la clé dans le fichier dédié `~/.ssh/authorized_keys.d/dependabot-tracker` (ligne `restrict` : ni redirection, ni agent, ni pseudo-terminal), fait lire ce fichier à sshd en plus de `~/.ssh/authorized_keys` (`/etc/ssh/sshd_config.d/10-dependabot-tracker.conf`, avec sudo), et ne recharge sshd que si sa configuration est valide et prend le fichier en compte ; sinon le réglage est retiré. `~/.ssh/authorized_keys` n'est jamais modifié. Le réglage nomme aussi le fichier de SSH Gate : sshd ne retenant que le premier `AuthorizedKeysFile`, un serveur où les deux sont installés garde l'accès de SSH Gate. « Clé publique seule » affiche la clé, pour l'installer autrement.
3. **Test** — le tracker se connecte, enregistre l'empreinte de la clé d'hôte (vérifiée à chaque connexion suivante : une clé d'hôte changée refuse la connexion), puis limite la ligne de sa clé à son adresse vue par le serveur (`from="…"`, lue dans `$SSH_CLIENT`). La nouvelle ligne est vérifiée par une seconde connexion avant d'être gardée ; refusée, la ligne d'origine est remise. Les lignes des autres clés du fichier ne sont pas touchées. Le résultat dit si la clé est bien dans le fichier dédié, limitée à une adresse, et signale une copie restée dans `~/.ssh/authorized_keys`.

Un serveur se partage entre dépôts : « Connecter un serveur » propose les serveurs déjà connectés avant « Nouveau serveur ». Modifier l'hôte ou le port d'un serveur oublie son empreinte et son test.

**Renouveler la clé** — comme dans SSH Gate, en quatre étapes : générer une nouvelle paire, ajouter sa ligne à côté de l'actuelle dans le fichier dédié (avec la même limite d'adresse), ouvrir une seconde connexion avec la nouvelle clé, puis ne garder qu'elle. Un échec avant la dernière étape remet le fichier dans son état d'origine et garde la clé actuelle : rien n'est perdu. Refusé tant que la connexion n'a pas été testée, quand la clé n'est pas dans le fichier dédié, ou quand elle figure aussi dans `~/.ssh/authorized_keys` (elle y resterait valable).

**Révoquer la clé** — le tracker retire sa ligne du fichier dédié (les autres lignes restent), vérifie qu'une nouvelle connexion est refusée, puis efface la clé : le serveur reste enregistré, « Sans clé ». Si le serveur accepte encore la clé, elle figure ailleurs et rien n'est effacé. Si le tracker ne peut pas se connecter, la fenêtre donne la commande qui retire la ligne, à lancer soi-même, puis « C'est fait, effacer la clé » l'oublie sans toucher au serveur. « Installer une clé » (menu « … », ou la pastille « Sans clé ») génère une nouvelle paire et rouvre l'assistant sur sa commande d'installation.

Le renouvellement et la révocation valent pour tous les dépôts qui utilisent le serveur, et sont refusés pendant un déploiement sur ce serveur.

**Script** — en bash, édité dans l'interface avec coloration syntaxique (la palette « sobre » de SSH Gate), numéros de ligne et ligne du curseur surlignée ; Tab indente, Ctrl+S enregistre, Échap annule. Le tracker définit trois variables : `$BRANCH` (la branche analysée du dépôt), `$COMMIT` (son dernier commit sur GitHub, lu au lancement) et `$REPO` (`propriétaire/nom`).

**Déploiement** — « Déployer », actif quand le serveur est testé et le script écrit, lance le script sur le serveur et le suit en direct. Le script est copié dans un dossier temporaire du serveur (`mktemp -d`, supprimé à la fin), puis exécuté avec bash depuis le dossier personnel, l'entrée venant de `/dev/null` ; sa sortie (stdout et stderr) s'affiche au fil de l'eau, et sa ligne en cours est lue dans la trace de bash (`set -x`, sur un descripteur à part : la sortie n'en contient rien). Un déploiement réussi (code 0) retire la marque « à déployer » du dépôt ; un échec donne le code de sortie et la ligne du script en cours. « Interrompre » envoie SIGTERM à tout le groupe de processus du script, puis ferme la connexion. Un seul déploiement à la fois par dépôt ; le retrait d'un dépôt est refusé pendant un déploiement. Un déploiement que l'arrêt du serveur a interrompu passe en échec au démarrage suivant. Les 20 derniers déploiements de chaque dépôt sont conservés, avec le script lancé et la sortie (ses 200 000 derniers caractères).

Le déploiement se pilote depuis l'interface seulement : les outils de l'agent n'y ont pas accès.

---

## L'interface

Thème sombre, une information par ligne, une action principale par écran.

- **Accueil (`#/`, `#/c/<catégorie>`)** — à gauche, la barre des catégories : « Tous mes projets », « File d'attente » avec le nombre de dépôts qu'elle contient, « PR en attente » avec le nombre de dépôts dont une pull request du tracker attend, « À déployer » avec le nombre de dépôts marqués, puis chaque catégorie, chacune avec le nombre d'alertes ouvertes de ses dépôts, coloré selon la plus grave (aucune pastille sans alerte), précédé du nombre de pull requests du tracker en attente (aucune pastille sans pull request). « Nouvelle catégorie » ouvre un champ en place (Entrée crée, Échap annule) ; au survol d'une catégorie, « … » propose de la renommer ou de la supprimer (un second clic confirme ; ses dépôts restent suivis, sans catégorie). Un dépôt appartient à une catégorie au plus. En bas de la barre, « Dépréciés » ouvre l'onglet des dépôts dépréciés, avec leur nombre.
  À droite, les dépôts non dépréciés de la catégorie choisie, du plus exposé au moins exposé (gravité la plus haute, puis nombre de vulnérabilités). L'interrupteur « Vulnérables seulement » ne garde que les dépôts réellement vulnérables : des paquets sans version corrigée au dernier audit, des alertes non corrigées à la main que le dernier audit ne contredit pas, ou des vulnérabilités trouvées par l'audit alors que Dependabot ne signale rien ; le navigateur retient sa position. Les dépôts forment un tableau à en-tête, une ligne par dépôt : le nom (`propriétaire/dépôt` en infobulle), suivi au survol d'une icône qui ouvre sa page GitHub dans un nouvel onglet (en permanence sur un écran tactile), trois colonnes de largeur fixe, « Sécurité », « Dernier audit » et « Suivi », puis les boutons et le chevron. Un contenu trop long est coupé, jamais poussé sur la colonne voisine, et l'infobulle le donne en entier.
  **Sécurité** — la pastille des alertes Dependabot non corrigées à la main, colorée selon la plus grave. Elle est estompée quand le dernier audit de la branche par défaut, plus récent que chacune d'elles, n'a trouvé aucune vulnérabilité : Dependabot n'a pas encore repassé. Elle est suivie de « dév. » quand toutes portent sur des dépendances de développement et que le dernier audit de production de la branche par défaut n'a rien trouvé. Des alertes toutes marquées corrigées à la main gardent une pastille estompée et ne comptent plus, ni ici, ni dans la barre des catégories. Sans alerte Dependabot, une pastille « N vulnérabilités » reprend ce qu'a trouvé le dernier audit de la branche par défaut, que Dependabot n'a pas encore vu ; ces vulnérabilités comptent dans la barre des catégories comme les alertes. « à la main » (icône de clé) signale les paquets pour lesquels le dernier audit n'a trouvé aucune version corrigée publiée, listés en infobulle. Sinon, la cellule affiche « Synchronisation impossible » (l'erreur en infobulle), « Synchronisation… » avant la première lecture, ou « — ».
  **Dernier audit** — l'opération en cours (« Audit en cours », « Correction en cours », « Corrections par Claude… »), sinon le résultat du dernier audit, quelle que soit sa branche, et sa date : « OK », « Prod. OK » pour un audit des seules dépendances de production, ou « N vulnérabilités » ; le périmètre et la branche sont en infobulle. Pour une correction qui a ouvert une pull request, c'est l'audit qui suit ses corrections, sur la branche de la pull request : la colonne montre tout de suite ce qu'il restera après la fusion. « — » sans audit.
  **Suivi** — des marqueurs discrets, chacun avec son infobulle : la pull request du tracker en attente (« #42 », ou « 2 PR », qui ouvre la liste des pull requests du dépôt), la tâche organizer du dernier rapport de Claude tant qu'elle n'est pas terminée (« MNT-12 », qui ouvre la tâche), la file d'attente et la marque « à déployer », leur date en infobulle.
  Les boutons de la ligne n'apparaissent qu'au survol, et en permanence sur un écran tactile. Le dernier, avant le chevron (icône archive), marque le dépôt **déprécié** (refusé pendant une opération). Un dépôt déprécié n'est plus synchronisé ni audité (ni par la relecture des 10 minutes, ni par « Synchroniser maintenant » et « Auditer tout », ni par l'agent), ne compte dans aucune pastille et quitte sa catégorie à l'affichage tout en la gardant. Le marquer déprécié le retire aussi de la file d'attente et lui retire la marque « à déployer ».
  Juste avant, un bouton (icône de fusée) marque le dépôt **à déployer**, pour un dépôt sans déploiement automatique dont la correction reste à déployer : il reste allumé tant que le dépôt est marqué, et un nouveau clic retire la marque.
  Avant ces boutons, un autre (icône de liste) met le dépôt dans la **file d'attente** ; il reste allumé tant que le dépôt y est, et un nouveau clic l'en retire. Dans une catégorie, « Tout ajouter à la file », à côté de l'interrupteur, y met d'un coup tous ses dépôts qui n'y sont pas encore (inactif quand ils y sont tous).
  « Ajouter un dépôt » ouvre une fenêtre avec un champ de recherche et la catégorie. Dès la première lettre, jusqu'à dix dépôts accessibles au token et pas encore suivis sont proposés (ceux dont le nom commence par la saisie d'abord) ; ↑ et ↓ parcourent, Entrée ou un clic reportent le dépôt dans le champ, Échap referme la liste, puis la fenêtre. La catégorie part de celle affichée. « Ajouter » valide ; sans suggestion, Entrée aussi. La saisie peut être `propriétaire/dépôt` ou un lien GitHub.
  Dans la colonne « Suivi », « #42 » ouvre la pull request sur GitHub, « 3 PR » la liste des pull requests du dépôt.
  « Synchroniser maintenant », à côté, relit tout de suite les alertes et les pull requests de tous les dépôts, sans attendre la relecture des 10 minutes ; l'icône tourne jusqu'à la fin. « Auditer tout » audite la branche par défaut de tous les dépôts (voir plus haut) : un clic l'audite en production, la flèche à côté propose « Production » ou « Toutes les dépendances » ; le bouton affiche la progression (« Audit 4/12… »), chaque dépôt audité affiche « Audit en cours », et un message final donne le nombre de dépôts audités, laissés de côté et en échec (avec leurs noms).
  La roue dentée, à gauche de « Synchroniser maintenant », ouvre les réglages.
- **File d'attente (`#/queue`)** — les dépôts mis en file, non dépréciés, dans l'ordre de leur entrée dans la file, avec les mêmes informations et le même interrupteur que l'accueil. Le chevron ouvre le dépôt pour l'auditer ou le corriger. « Traité », sur chaque ligne, retire le dépôt de la file sans toucher à sa catégorie.
- **PR en attente (`#/pulls`)** — les dépôts non dépréciés dont une pull request du tracker attend d'être mergée, de la plus ancienne à la plus récente, avec l'interrupteur de l'accueil. Une correction aboutie y place son dépôt dès l'ouverture de sa pull request. Sur chaque ligne, « Mergée » retire aussitôt le dépôt de l'onglet, pour un dépôt au déploiement automatique ; « Mergée, à déployer » le fait passer en plus dans « À déployer ». Les deux lancent aussitôt, en arrière-plan, un audit de la branche par défaut, sur le périmètre de la correction qui a ouvert la pull request : la liste reflète la branche fusionnée sans attendre que Dependabot repasse. Ils sont refusés tant qu'une opération est en cours sur le dépôt. La relecture des 10 minutes retire aussi les pull requests mergées ou fermées sur GitHub ; une pull request marquée mergée mais encore ouverte sur GitHub y revient à la lecture suivante.
- **À déployer (`#/deploy`)** — les dépôts marqués « à déployer », non dépréciés, dans l'ordre où ils ont été marqués, avec les colonnes de l'accueil (la date de la marque en infobulle de la fusée) et son interrupteur. Le chevron ouvre le dépôt. « Déployé », sur chaque ligne, retire la marque sans toucher à sa catégorie ni à la file d'attente.
- **Réglages (`#/settings`)** — connexion à l'organizer, token Claude, limites des corrections par Claude et tokens d'accès des agents (voir [Les corrections par Claude](#les-corrections-par-claude)). Un token enregistré n'apparaît que par ses quatre derniers caractères, avec « Remplacer ». « Enregistrer » valide les trois premières sections ; les tokens d'agent se créent et se révoquent aussitôt.
- **Dépréciés (`#/deprecated`)** — les dépôts dépréciés, du plus récent au plus ancien, avec la date de dépréciation. « Rétablir », sur chaque ligne, remet le dépôt dans sa catégorie et relit aussitôt ses alertes. Le chevron ouvre l'écran du dépôt, où « Corriger » est désactivé.
- **Dépôt (`#/r/<propriétaire>/<nom>`, `#/r/<propriétaire>/<nom>/history`)** — le nom du dépôt, suivi d'une icône qui ouvre sa page GitHub dans un nouvel onglet (sur le serveur de `GITHUB_SERVER_URL`), sélecteur de la branche analysée (un clic ouvre la liste des branches avec un champ de recherche, la branche par défaut en tête ; ↑ ↓ et Entrée ou un clic choisissent, Échap ferme), sélecteur de la catégorie (« Sans catégorie » ou l'une des catégories) et date de la dernière lecture des alertes, puis trois onglets. **Alertes ouvertes**, avec leur nombre : les alertes ouvertes (gravité, paquet, résumé), chacune ouvrant l'alerte sur GitHub. Une alerte dont le paquet n'a aucune version corrigée publiée porte « ⚠ sans correctif », une alerte sur une dépendance de développement l'étiquette « dév. ». Au survol d'une alerte, « Corrigée à la main » la range dans la section « Corrigées à la main », avec la date du marquage ; « Rétablir » la remet à traiter. Dependabot continue souvent de signaler une alerte corrigée à la main (un paquet installé hors du registre npm, par exemple) : la marque tient tant que l'alerte reste ouverte, et tombe à la lecture suivante si Dependabot émet une nouvelle alerte sur le même paquet. **Historique**, avec le nombre d'opérations : une ligne par opération conservée (les 20 dernières du dépôt), de la plus récente à la plus ancienne, avec audit ou correction, qui l'a lancée, le périmètre, la branche, la date, les vulnérabilités avant et après (le début de l'erreur pour une opération échouée), la part de Claude (« Claude » quand il a été lancé) et l'issue (la pull request, « terminée », « annulée », « échouée ») ; chaque ligne ouvre l'opération. **Déploiement** (`…/deploy`) : sans serveur, « Connecter un serveur » ouvre l'assistant de connexion (ou propose d'abord les serveurs déjà connectés). Avec un serveur : sa ligne (nom, adresse, dernier déploiement, « Connecté » ou « À tester », « Déployer », et un menu « … » : commande d'installation et test, modifier le serveur, renouveler ou révoquer la clé, changer de serveur, ne plus déployer ce dépôt), le script coloré avec « Modifier », puis les derniers déploiements (branche, commit, date, durée, issue), chacun ouvrant son détail (`…/deploy/<id>`) : le script avec la ligne en échec surlignée et la sortie. Pendant un déploiement, l'onglet montre son exécution : la ligne en cours surlignée, les suivantes estompées, la sortie qui défile, et « Interrompre » à la place de « Déployer ». « Corriger » lance une correction en production ; la flèche à côté ouvre le choix du périmètre (« Production » ou « Toutes les dépendances », Échap ferme). « Voir la correction en cours » rouvre celle en cours. À gauche de la corbeille, « Traité » retire de la file d'attente un dépôt qui y est et ramène à la file ; pour un dépôt hors de la file, « Ajouter à la file » l'y met (absent pour un dépôt déprécié). Juste avant, « À déployer » marque le dépôt ; une fois marqué, le bouton s'allume et devient « Déployé », qui retire la marque (absent pour un dépôt déprécié). La corbeille retire le dépôt du suivi : elle devient « Confirmer le retrait », qu'un second clic dans les 4 secondes confirme ; refusé pendant une opération.
- **Correction (`#/r/<propriétaire>/<nom>/op/<id>`)** — qui l'a lancée (vous ou l'agent), la branche clonée, le périmètre ; les flèches « 1 / 5 » passent à l'opération plus récente ou plus ancienne du dépôt, la flèche de retour ramène à son historique. Trois onglets : **Étapes**, **Claude** (quand Claude est intervenu) et **Journal**. Les étapes se suivent sans décision à prendre : chacune tient sur une ligne avec son résultat (« 4 vulnérabilités », « 3 corrigées », lien vers la pull request). Une étape passée en donne la raison : « rien à corriger » quand `npm audit fix` a tout corrigé, « rien à pousser » quand les corrections n'ont rien changé, « ignorée » sinon. Les vulnérabilités sans aucune version corrigée publiée sur le registre npm (`fixAvailable: false`, par exemple `xlsx`, que SheetJS ne publie plus sur npm) sont comptées sur la ligne du dernier audit (« 1 sans correctif ») ; un clic les liste avec leur gravité : leur mise à jour est à faire à la main. Pendant les corrections par Claude, l'étape montre leur durée, leurs tours et les trois dernières actions de Claude ; ensuite, ce qu'il a changé : résumé, fichiers, tests, vulnérabilités restantes et lien vers sa tâche de rapport. Un échec de Claude s'affiche sous l'étape (« échouées · corrections de npm audit fix seules »). Une fois la pull request ouverte, l'étape du push montre la branche et « voir les changements » (paquets mis à jour, replié) ; tant que la pull request attend, elle propose aussi « Mergée » et « Mergée, à déployer », comme l'onglet « PR en attente ». Une erreur s'affiche sous l'étape qui a échoué. L'onglet « Claude » montre la session : sa tâche de rapport, le déroulé complet de ses messages et de ses actions (500 derniers) et son résultat : le résumé des corrections, les fichiers modifiés, le commit, les tests et les vulnérabilités restantes, ou la raison de l'échec. L'onglet « Journal » montre les commandes lancées et leurs résultats ; « Annuler » arrête l'opération.

Les écrans se relisent par polling : toutes les 3 s pour les listes, toutes les secondes pendant une opération. Un écran rouvert affiche aussitôt la dernière réponse reçue, puis se met à jour ; seuls les réglages attendent une lecture fraîche.

---

## Architecture

Un point d'entrée, `src/index.ts`, et deux modes :

- **Serveur** (`serve`, `src/server/`) — un seul processus : Hono sert l'interface, son API et l'API des agents, qui appellent directement la logique (`src/core/`) ; il mène les opérations, relit les alertes et les pull requests toutes les 10 minutes, et écoute sur `APP_PORT`. Better Auth (`src/core/auth.ts`, base SQLite `<données>/auth.sqlite`, migrée au démarrage) sert `/api/auth/…` ; un middleware exige une session sur le reste de `/api/…`, hors `/api/agent/…`, protégé par les tokens d'agent. Au démarrage, une opération encore en cours, interrompue par l'arrêt précédent, passe en échec et perd son clone.
- **Mode MCP** (`mcp`, `src/mcp.ts`, `src/tools/`) — JSON-RPC sur stdio : chaque outil appelle l'API des agents du serveur et met sa réponse en forme.

| Route | Effet |
|---|---|
| `GET` / `POST /api/auth/…` | Routes de Better Auth : `sign-in/email`, `sign-out`, `get-session`… L'inscription (`sign-up/email`) est fermée. |
| `GET /api/config` | Version, répertoire des données, adresse du serveur GitHub. |
| `GET /api/repos`, `POST /api/repos` | Dépôts suivis, dépréciés compris (avec catégorie, opération en cours et dernière opération) et catégories ; ajout d'un dépôt (`{ repository, categoryId? }`). |
| `POST /api/sync` | Relit tout de suite les alertes et les pull requests de chaque dépôt suivi non déprécié, en parallèle ; renvoie les dépôts et les catégories. |
| `GET /api/audit-all`, `POST /api/audit-all` | État de la dernière série « Auditer tout » (`null` si aucune depuis le démarrage) : en cours ou non, dépôts traités sur le total, laissés de côté, en échec avec la raison ; lancement d'une série sur le périmètre `scope` du corps (`production` ou `all`) et les dépôts de `target` : `{ "kind": "all" }`, `{ "kind": "category", "categoryId": … }` ou `{ "kind": "queue" }` (`404` si la catégorie n'existe pas, `409` si une série est en cours). |
| `GET /api/github/repos` | Dépôts accessibles au token (`/user/repos`) et pas encore suivis, pour les suggestions d'ajout. |
| `GET` / `DELETE /api/repos/:propriétaire/:nom` | Dépôt ; retrait. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/deprecated` | Marque le dépôt déprécié (`409` pendant une opération) et lui retire la file d'attente et la marque « à déployer » ; le rétablit et relit ses alertes. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/queued` | Met le dépôt dans la file d'attente (`409` pour un dépôt déprécié ; sans effet s'il y est déjà) ; l'en retire. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/deploy-pending` | Marque le dépôt « à déployer » (`409` pour un dépôt déprécié ; sans effet s'il l'est déjà) ; retire la marque. |
| `PUT /api/repos/:propriétaire/:nom/merged` | Retire les pull requests en attente du dépôt, que l'utilisateur dit mergées (`{ deploy }` : avec `true`, le dépôt passe aussi « à déployer » ; `409` pour un dépôt déprécié). |
| `GET /api/repos/:propriétaire/:nom/branches`, `PUT …/branch` | Branches du dépôt, la branche par défaut en tête ; choix de la branche analysée (`{ branch }`, qui doit exister). |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/alerts/:numéro/handled` | Marque une alerte ouverte corrigée à la main ; retire la marque. |
| `PUT /api/repos/:propriétaire/:nom/category` | Catégorie du dépôt (`{ categoryId }`, null pour aucune). |
| `GET /api/categories`, `POST /api/categories` | Catégories dans l'ordre alphabétique ; création (`{ name }`, unique sans tenir compte de la casse). |
| `PUT` / `DELETE /api/categories/:id` | Renommage (`{ name }`) ; suppression, ses dépôts restant sans catégorie. |
| `PUT /api/categories/:id/queued` | Met dans la file d'attente les dépôts non dépréciés de la catégorie qui n'y sont pas encore ; rend la liste des dépôts et des catégories. |
| `POST /api/repos/:propriétaire/:nom/operations` | Lance une correction sur le périmètre `scope` du corps (`production` ou `all`). |
| `GET /api/repos/:owner/:name/operations` | Historique du dépôt : ses opérations conservées, sans journal ni session de Claude. |
| `GET /api/operations/:id` | Opération, avec la session de Claude. |
| `POST /api/operations/:id/cancel` | Annulation d'une opération en cours. |
| `GET /api/settings`, `PUT /api/settings` | Réglages des corrections par Claude, tokens réduits à leurs quatre derniers caractères ; enregistrement (`{ organizerUrl, organizerToken?, claudeToken?, analysis }`, un token absent est gardé), refusé si la connexion à l'organizer ou le token Claude échoue. |
| `POST /api/settings/organizer/test` | Reteste la connexion enregistrée à l'organizer. |
| `GET /api/agent-tokens`, `POST /api/agent-tokens` | Tokens d'agent, du plus récent au plus ancien (nom, quatre derniers caractères, création, dernière utilisation) ; création (`{ name }`), qui rend le token en clair, une seule fois, et la commande `--claude-setup-mcp` qui le déclare. |
| `DELETE /api/agent-tokens/:id` | Révoque un token. |
| `GET /api/deploy-servers`, `POST /api/deploy-servers` | Serveurs de déploiement, avec la commande d'installation de leur clé ; création (`{ name, host, port, username }`), qui génère la paire de clés. |
| `PUT /api/deploy-servers/:id` | Modifie un serveur ; un nouvel hôte ou port oublie son empreinte et son test. |
| `POST /api/deploy-servers/:id/test` | Teste la connexion, enregistre l'empreinte de l'hôte et limite la clé à l'adresse du tracker ; rend l'empreinte, le dossier du shell et la place de la clé. |
| `POST /api/deploy-servers/:id/key` | Nouvelle paire de clés pour un serveur dont la clé a été révoquée. |
| `POST /api/deploy-servers/:id/key/rotate` | Renouvelle la clé ; rend l'état des quatre étapes et l'erreur qui a arrêté le renouvellement (`409` pendant un déploiement sur le serveur). |
| `POST /api/deploy-servers/:id/key/revoke`, `POST …/key/forget` | Retire la clé du serveur, vérifie le refus et l'efface ; l'efface sans toucher au serveur (`409` pendant un déploiement sur le serveur). |
| `GET /api/repos/:propriétaire/:nom/deploy` | Serveur, script, déploiement en cours et derniers déploiements du dépôt. |
| `PUT /api/repos/:propriétaire/:nom/deploy/server`, `PUT …/deploy/script` | Serveur du dépôt (`{ serverId }`, null le détache) ; script (`{ script }`). |
| `POST /api/repos/:propriétaire/:nom/deployments` | Lance un déploiement (`409` sans serveur testé, sans script, ou pendant un autre déploiement). |
| `GET /api/deployments/:id`, `POST /api/deployments/:id/cancel` | Déploiement, avec son script et sa sortie ; interruption. |

L'API des agents, sous `/api/agent/`, exige l'en-tête `Authorization: Bearer <token d'agent>` (`401` sinon) :

| Route | Effet |
|---|---|
| `GET /api/agent/repos?category=<nom>` | Dépôts non dépréciés, tous ou ceux de la catégorie (`404` si elle n'existe pas). |
| `POST /api/agent/repos/:propriétaire/:nom/sync` | Relit les alertes du dépôt sur GitHub et le rend. |
| `POST /api/agent/repos/:propriétaire/:nom/audits` | Lance un audit de la branche analysée (`{ scope }`). |
| `POST /api/agent/repos/:propriétaire/:nom/fixes` | Lance une correction (`{ scope, claude }`). |
| `GET /api/agent/operations/:id` | Opération. |
| `POST /api/agent/operations/:id/cancel` | Annulation d'une opération en cours. |

Les routes des opérations rendent `{ operation, guiUrl }`, `guiUrl` étant l'adresse de l'écran de l'opération dans l'interface.

Erreurs : `400` requête invalide, `401` token d'agent absent ou révoqué, `404` introuvable, `409` conflit (opération déjà en cours ou déjà terminée, dépôt déprécié), `500` sinon.

### Persistance

`<données>/repos.json` pour les catégories et les dépôts (catégorie, alertes, alertes corrigées à la main, dernière lecture, date de dépréciation), `<données>/operations/<id>.json` pour chaque opération (session de Claude comprise) ; les 20 plus récentes sont conservées par dépôt. `<données>/settings.json` porte les réglages des corrections par Claude et leurs tokens, `<données>/agent-tokens.json` les tokens d'agent, dont seule l'empreinte SHA-256 est conservée ; les deux fichiers ne sont lisibles que par le compte du serveur. `<données>/claude` garde la configuration de Claude Code. `<données>/deploy-servers.json` porte les serveurs de déploiement, leur clé privée chiffrée avec `VAULT_KEY`, lisible par le seul compte du serveur ; `<données>/deployments/<id>.json` chaque déploiement, les 20 plus récents par dépôt. Le serveur et le script de déploiement d'un dépôt sont dans `repos.json`. Le serveur est le seul processus qui écrit ces fichiers ; chaque écriture est atomique. Une opération enregistrée par une version qui attendait une décision de l'utilisateur est lue comme annulée.

---

## Développement

```bash
npm install
npm run build   # backend (tsc -> dist/), puis GUI (gui/dist)
npm test        # node --test sur dist/test
cd gui && npm run lint   # oxlint
```

| Dossier | Contenu |
|---|---|
| `src/index.ts` | Point d'entrée : `serve`, `mcp`, `--claude-setup-mcp`, `--generate-vault-key`. |
| `src/server/` | Serveur : démarrage, exposition, relecture périodique (`serve.ts`) ; routes de l'interface, de l'API des agents et fichiers de la SPA (`app.ts`). |
| `src/mcp.ts` | Mode MCP : `instructions` et serveur stdio des outils. |
| `src/tools/` | Outils du mode MCP, client de l'API des agents, mise en forme des résultats. |
| `src/core/` | Stockage, tokens d'agent, client GitHub, commandes `git`/`npm`, rapports `npm audit` et lockfiles, opérations, dépôts ; coffre (`vault.ts`), connexion SSH (`ssh.ts`), serveurs de déploiement (`deploy-servers.ts`) et déploiements (`deployments.ts`) ; configuration du serveur (`server-config.ts`) et authentification (`auth.ts`). |
| `src/npm-tools.ts` | Serveur MCP des commandes npm fourni à Claude Code pendant ses corrections. |
| `src/cli/setup-mcp.ts` | Commande `--claude-setup-mcp`. |
| `src/cli/users.ts` | Commandes `user add`, `user password`, `user totp`, `user remove`, `user list`. |
| `shared/schemas/` | Schémas zod communs au serveur et à la GUI. |
| `gui/` | Vite + React 19 + zustand, CSS écrit à la main. |
| `test/` | Tests `node --test`. |

Les tests utilisent une fausse API GitHub (dépôts, alertes paginées, utilisateur, création et liste des pull requests) et des dépôts nus locaux servis par `file://` (`GITHUB_API_URL`, `GITHUB_SERVER_URL`). `test/operations.test.ts` et `test/server.test.ts` lancent un vrai `npm audit` sur un petit projet vulnérable (`test/fixtures/vulnerable` : `lodash`, corrigé par `audit fix`, et `nth-check`, qui demande une montée majeure ; `test/fixtures/vulnerable-dev`, le même avec `nth-check` en devDependency, pour le périmètre production) : ils ont besoin du registre npm et sont ignorés, avec la raison, s'il est injoignable. `test/server.test.ts` crée un compte (`user add`), lance le serveur (`serve`) sur un port libre, ouvre une session, vérifie l'authentification (session exigée, inscription fermée, requêtes d'un autre site, commandes `user`, limitation des connexions), crée un token d'agent par l'API de l'interface, puis lance le mode MCP (`mcp`) sur stdio : il parcourt les outils, les tokens et la correction complète depuis l'API de l'interface. Les corrections par Claude passent par un faux Claude Code (`test/fake-claude.ts`, qui note ses appels, appelle les outils du serveur `npm` du tracker et répond en `stream-json`) et un faux organizer (tâches, assignations, tags). `test/deploy.test.ts` connecte un serveur et déploie sur un faux serveur SSH (`test/fake-ssh.ts`, bâti sur `ssh2`) qui n'accepte que les clés du fichier dédié, en respectant leur option `from`, et exécute réellement les commandes avec bash : `bash` doit être dans le `PATH` (Git Bash sous Windows). `test/two-factor.test.ts` active la double authentification d'un compte (`user totp`) sur son propre serveur et vérifie la connexion en deux étapes, par code TOTP puis par code de secours.

## Publication

Chaque push sur `master`, merge de pull request compris, publie une nouvelle version sur npm (`.github/workflows/publish.yml`) : installation de bubblewrap (les tests des corrections par Claude passent par le bac à sable des commandes npm), `npm ci`, build, tests, puis `npm version patch`, `npm publish`, et enfin le push sur `master` du commit et du tag de version. La publication passe par le trusted publishing de npm (OIDC, sans token), avec attestation de provenance. Un échec du build ou des tests arrête le workflow avant la montée de version ; un échec de `npm publish` l'arrête avant le push, si bien que relancer le run reprend la même version.

Sur npmjs.com, le paquet déclare ce workflow comme publieur de confiance (Settings → Trusted publishing → GitHub Actions : `Matthieu-Pesnot-Pin`, `mcp-dependabot-tracker`, `publish.yml`, avec `npm publish` dans les actions autorisées). Le commit de version est poussé avec `GITHUB_TOKEN` : si `master` est protégée, la règle doit autoriser GitHub Actions à y pousser.
