# @imenam/mcp-dependabot-tracker

Suivi des alertes Dependabot de dépôts GitHub, et correction de leurs dépendances vulnérables (projets npm, pnpm et Composer) dans un clone temporaire, depuis une interface web ou par un agent.

Pour chaque dépôt suivi, l'interface montre les alertes Dependabot ouvertes et lance une **correction**, menée de bout en bout sans intervention : clone temporaire de la branche choisie pour le dépôt (la branche par défaut tant qu'aucune autre n'est choisie), audit de chaque projet, corrections automatiques de son gestionnaire de paquets, corrections par Claude s'il reste des vulnérabilités, puis commit sur une nouvelle branche, push et pull request.

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

L'agent fait ce que fait l'utilisateur pour les corrections : il liste les dépôts, lance des audits et des corrections, corrections par Claude comprises, les suit et les annule. Il n'exécute jamais `git` ni un gestionnaire de paquets lui-même. Les réglages, les catégories, la file d'attente et les tokens restent dans l'interface. Quand `npm audit fix` laisse des vulnérabilités, une correction fait **corriger par Claude** (Claude Code, avec un abonnement Claude) : il analyse chaque vulnérabilité dans le code, corrige ce qu'il peut dans un commit séparé, et rend compte de son travail dans une seule tâche d'un [organizer](https://www.npmjs.com/package/@imenam/mcp-organizer) (voir [Les corrections par Claude](#les-corrections-par-claude)).

---

## Installation

### Installation sur un serveur Linux : `setup`

Sur une machine Linux avec systemd (Debian, Ubuntu), une seule commande, en root, installe tout le serveur :

```bash
sudo mcp-dependabot-tracker setup
```

Elle pose ses questions, en proposant les valeurs du `.env` existant : adresse publique (`https://…`), port d'écoute sur `127.0.0.1` (4700), compte système du service (`dependabot-tracker`), répertoire des données (`<dossier du compte>/data`), nginx et certificat, premier compte de l'interface (mot de passe saisi sans écho). Elle récapitule, demande confirmation, puis :

1. installe les paquets manquants : `git`, `podman`, `uidmap`, `passt`, `slirp4netns`, `catatonit`, `bubblewrap`, `socat`, plus `nginx`, `certbot` et `python3-certbot-nginx` s'ils sont demandés ;
2. crée le compte système du service, lui attribue une plage de sous-identifiants libre (la suite de toutes celles de `/etc/subuid` et `/etc/subgid`) et active son lingering (`/run/user/<uid>`) ;
3. écrit le `.env` de la racine du paquet (`DATA_DIR`, `APP_URL`, `APP_PORT`, `TRUSTED_PROXIES`, et `VAULT_KEY` et `AUTH_SECRET`, générés au premier passage puis conservés), lisible par root et le groupe du service seulement ; les autres lignes du fichier sont gardées ;
4. crée le premier compte de l'interface ;
5. prépare Podman rootless sous le compte du service (`podman system migrate`) et vérifie qu'il est bien rootless ;
6. écrit l'unité `/etc/systemd/system/dependabot-tracker.service`, l'active et (re)démarre le service, puis attend que le serveur réponde ;
7. avec nginx, écrit et active le site `/etc/nginx/sites-available/dependabot-tracker` (proxy vers `127.0.0.1:<port>`), recharge nginx, puis obtient le certificat avec certbot (`--redirect`). Un site nginx déjà activé qui sert la même adresse est gardé tel quel.

L'unité garde le durcissement compatible avec Podman rootless et le bac à sable de Claude Code : `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, l'écriture limitée au dossier du compte, aux données et à `/run/user/<uid>`, mais ni `NoNewPrivileges` (`newuidmap` et `newgidmap` sont setuid), ni `RestrictSUIDSGID` (la copie d'une image aux identifiants décalés de `--userns=keep-id` remet les bits setuid et setgid de ses fichiers), ni `RestrictNamespaces`, `PrivateUsers` ou `SystemCallFilter` (bubblewrap).

Relancée, la commande reprend la configuration en place : clés, compte de service, plage de sous-identifiants et comptes existants sont gardés, l'unité est réécrite. Sans terminal, ou avec `--non-interactive`, rien n'est demandé : chaque réponse vient d'une option (`--app-url`, `--port`, `--service-user`, `--data-dir`, `--nginx=oui|non`, `--certbot=oui|non`, `--admin-email`, `--admin-name`), sinon du `.env` ou du défaut, et le mot de passe de `SETUP_ADMIN_PASSWORD`. `setup --help` les liste. Il reste ensuite à saisir dans l'interface le token GitHub du tracker, puis le token Claude.

### Le serveur

```bash
npm install -g @imenam/mcp-dependabot-tracker
mcp-dependabot-tracker serve
```

Ou via `npx -y @imenam/mcp-dependabot-tracker serve`. Le serveur se lance comme un service (systemd, conteneur…) : il tourne en continu, que des agents soient connectés ou non, et une correction en cours survit à la fermeture de l'agent qui l'a lancée. `git` et **Podman** doivent être dans le `PATH` de la machine qui l'exécute : toutes les commandes des gestionnaires de paquets d'une opération (`npm audit`, `npm audit fix`, installations et tests des corrections par Claude) tournent dans des conteneurs Podman jetables (voir [Une opération](#une-opération)), si bien que le serveur n'a besoin ni de npm ni d'aucun autre outil des projets audités. Claude Code, utilisé par les corrections par Claude, est une dépendance du package (`@anthropic-ai/claude-code`, Node 22 ou plus récent) ; sous Linux, il exige bubblewrap (`sudo apt-get install -y bubblewrap socat`, voir [Les corrections par Claude](#les-corrections-par-claude)).

Podman doit tourner en mode **rootless**, sous le compte non privilégié du service : le tracker le vérifie au début de chaque opération (`podman info`) et refuse de travailler avec un Podman rootful. Sur Ubuntu 24.04 :

```bash
sudo apt-get install -y podman uidmap passt
grep "^$(whoami):" /etc/subuid /etc/subgid
sudo loginctl enable-linger "$(whoami)"
podman info --format '{{.Host.Security.Rootless}}'
```

La deuxième commande doit afficher une plage pour le compte dans `/etc/subuid` et dans `/etc/subgid` ; sinon, ajoutez-en une (`sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$(whoami)"`), puis lancez `podman system migrate`. La dernière doit afficher `true`. Un service systemd lancé sous ce compte déclare aussi le dossier d'exécution de l'utilisateur, que Podman rootless attend : `Environment=XDG_RUNTIME_DIR=/run/user/<uid du compte>`, le laisse en écriture (`ReadWritePaths=/run/user/<uid du compte>` avec `ProtectSystem=strict`), et ne pose ni `NoNewPrivileges` ni `RestrictSUIDSGID` (voir l'unité écrite par `setup`, ci-dessus).

Le serveur exige une clé de coffre, `VAULT_KEY`, qui chiffre les clés privées SSH des serveurs de déploiement et les tokens de l'organizer et de Claude. Générez-la une fois et déclarez-la comme variable secrète du service :

```bash
npx -y @imenam/mcp-dependabot-tracker --generate-vault-key
```

Le serveur journalise sur sa sortie d'erreur et dans `<logs>/server.log` ; au démarrage, il donne l'adresse de son interface. Un répertoire de données ne sert qu'à un serveur à la fois.

### Exposition et authentification

Le serveur est une application autonome : il sert lui-même l'interface à l'adresse `APP_URL`, sur le port `APP_PORT`.

- **L'interface et son API** exigent une session ouverte avec un compte e-mail et mot de passe ([Better Auth](https://www.better-auth.com)). Les sessions durent 7 jours, sont prolongées à l'usage et vivent dans un cookie `HttpOnly`, `SameSite=Lax`, `Secure` en https. Les tentatives de connexion sont limitées à 5 par minute et par client, toutes les requêtes d'authentification à 100 par minute. Une requête de modification venue d'un autre site est refusée (`Sec-Fetch-Site`, à défaut `Origin`). Chaque réponse porte des en-têtes de sécurité : une `Content-Security-Policy` qui ne laisse charger que les ressources du serveur et interdit l'affichage dans un cadre (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, et HSTS (un an) avec une `APP_URL` en https.
- **L'API des agents** (`/api/agent/…`) exige un token d'agent (`Authorization: Bearer dtk_…`), et rien d'autre.

`APP_URL` est en https, derrière le reverse proxy qui porte le certificat (Caddy, nginx…), sauf sur `localhost` (`http://localhost:<port>`). Le serveur n'écoute que sur `127.0.0.1` par défaut : seul un reverse proxy de la même machine le joint, et le port HTTP en clair n'est jamais exposé. Si le reverse proxy est ailleurs (autre machine, autre conteneur), donnez dans `LISTEN_HOST` l'adresse sur laquelle écouter, ou `0.0.0.0` pour toutes les interfaces, et réservez le port au proxy par le pare-feu ; avec une `APP_URL` en http, seule la boucle locale est admise. Derrière un reverse proxy, déclarez l'adresse du reverse proxy dans `TRUSTED_PROXIES` : le limiteur de débit identifie alors le client par `X-Forwarded-For`, et non par l'adresse du proxy. Sans `TRUSTED_PROXIES`, `X-Forwarded-For` est ignoré.

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

Il n'y a pas d'inscription : les comptes se créent sur la machine du serveur, avec le même environnement que lui (`DATA_DIR`, `APP_URL`, `AUTH_SECRET`, ou le `.env` du package). Le mot de passe est demandé deux fois, sans être affiché ; il fait au moins 12 caractères.

```bash
mcp-dependabot-tracker user add admin@example.com --name="Admin"
mcp-dependabot-tracker user password admin@example.com
mcp-dependabot-tracker user totp admin@example.com
mcp-dependabot-tracker user remove admin@example.com
mcp-dependabot-tracker user list
```

Changer le mot de passe ou supprimer le compte ferme aussitôt ses sessions. Sans terminal, le mot de passe est lu sur la première ligne de l'entrée standard. Tant qu'aucun compte n'existe, le serveur le signale au démarrage. Comptes et sessions sont enregistrés dans `<données>/auth.sqlite`.

**Double authentification** — un compte ouvre l'exécution de scripts sur les serveurs de déploiement : protégez-le par un second facteur. `user totp <email>` affiche, dans un terminal, un QR code à scanner avec une application d'authentification (TOTP, six chiffres, 30 s), puis la clé à saisir à la main, son adresse `otpauth://` et dix codes de secours à usage unique, puis demande le code affiché par l'application : la double authentification n'est activée qu'avec un code juste, et les sessions du compte sont alors fermées. Sans terminal, elle est activée sans cette vérification, et la sortie ne contient pas de QR code. La connexion se fait ensuite en deux étapes : e-mail et mot de passe, puis le code de l'application ou un code de secours ; le mot de passe seul n'ouvre aucune session. Cinq codes faux ferment la vérification en cours, dix d'affilée verrouillent le compte un quart d'heure. Relancer `user totp <email>` remplace la clé et les codes de secours ; `user totp <email> --remove` retire la double authentification. `user list` indique pour chaque compte s'il l'a activée, et le serveur signale au démarrage ceux qui ne l'ont pas.

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

### Tokens GitHub

Le tracker utilise deux tokens GitHub, saisis dans l'interface (écran Réglages, section « GitHub — accès aux dépôts ») et chiffrés avec `VAULT_KEY` dans `<données>/settings.json`. Chacun est vérifié auprès de GitHub à l'enregistrement : un token refusé n'est pas enregistré, et l'écran affiche ses quatre derniers caractères, son compte et sa date d'expiration. Ils se remplacent sans redémarrer le serveur.

- **Token du tracker** — lit les alertes, clone les dépôts, pousse les branches de correction et ouvre les pull requests. Il ne quitte jamais le processus du tracker. Sans lui, le serveur démarre et l'interface fonctionne, mais rien n'est synchronisé, audité ni corrigé : ces actions renvoient vers les Réglages, et le journal le signale au démarrage. Il se remplace, il ne se retire pas.
- **Token de déploiement** — facultatif, en lecture seule, transmis aux scripts de déploiement pour leur `git pull` (voir [Accès au code des dépôts privés](#le-déploiement)).

Deux tokens plutôt qu'un : le token de déploiement voyage jusqu'aux serveurs cibles, où les scripts d'installation des paquets peuvent le lire ; il ne doit donc rien permettre de plus que lire du code déjà présent sur ces serveurs. Le token du tracker, qui écrit sur les dépôts, reste dans le tracker.

**Reprise de `GITHUB_TOKEN`** — tant que les réglages n'ont pas de token du tracker, une variable `GITHUB_TOKEN` présente dans l'environnement est reprise au démarrage : vérifiée auprès de GitHub (un refus est signalé dans le journal, le token est repris quand même), chiffrée, puis enregistrée dans les réglages. Ensuite, c'est le token des réglages qui compte : une variable `GITHUB_TOKEN` encore présente est ignorée, avec un avertissement dans le journal. Retirez-la de l'environnement une fois reprise.

Le token du tracker est un token à grain fin, limité aux dépôts suivis, avec les permissions :

| Permission | Accès | Pour |
|---|---|---|
| Dependabot alerts | lecture | lire les alertes |
| Contents | lecture et écriture | cloner, pousser la branche de correction |
| Pull requests | lecture et écriture | ouvrir la pull request, suivre celles qui attendent d'être mergées |
| Metadata | lecture | imposée par GitHub ; liste les dépôts proposés à l'ajout |

Un token classique convient aussi, avec le scope `repo` (qui comprend `security_events`), mais il ouvre tous vos dépôts, organisations comprises. Les commits sont signés du compte du token, avec son adresse `noreply` GitHub. Le token est transmis à `git` par un en-tête HTTP (`http.<serveur>/.extraheader`, dans l'environnement de la commande) : il n'est écrit ni dans le clone ni dans la ligne de commande. Les commandes `git` et `npm` ne reçoivent du serveur que ses variables système (`PATH`, `HOME`, langue, dossiers temporaires, proxy et certificats) : ni les tokens GitHub, ni `VAULT_KEY`, ni `AUTH_SECRET`, ni aucune autre variable du service.

### Variables d'environnement du serveur

Elles se renseignent dans l'environnement du service, ou dans un fichier `.env` à la racine du package, qui prime.

| Variable | Rôle |
|---|---|
| `GITHUB_TOKEN` | Facultatif. Repris au premier démarrage comme token du tracker, puis ignoré : le token se règle dans l'interface (voir [Tokens GitHub](#tokens-github)). |
| `DATA_DIR` | **Obligatoire, sans défaut.** Répertoire des données : comptes, sessions, tokens, scripts de déploiement, et clones des opérations dans `<DATA_DIR>/clones`. Il est créé s'il n'existe pas ; hors de Windows, le serveur le réserve à son compte (droits `700`) à chaque démarrage, et ses fichiers sont écrits en `600`. Requis par les modes `serve` et `user` ; le mode `mcp` ne stocke rien. |
| `VAULT_KEY` | **Obligatoire.** 32 octets en base64 (`--generate-vault-key`), qui chiffrent en AES-256-GCM les clés privées des serveurs de déploiement et les tokens de l'organizer et de Claude. Sans elle, ou si elle ne déchiffre pas les clés et les tokens déjà enregistrés, le serveur refuse de démarrer. La perdre oblige à reconnecter chaque serveur et à ressaisir les deux tokens. |
| `APP_PORT` | **Obligatoire.** Port d'écoute du serveur. |
| `APP_URL` | **Obligatoire.** Adresse publique de l'interface, sans chemin : `https://…`, ou `http://localhost:<port>` sur la machine elle-même (voir [Exposition et authentification](#exposition-et-authentification)). |
| `AUTH_SECRET` | **Obligatoire.** Secret de signature des sessions, 32 caractères au moins (`--generate-auth-secret`). |
| `LISTEN_HOST` | Adresse IP d'écoute (défaut `127.0.0.1`) ; `0.0.0.0` ou `::` pour toutes les interfaces, à n'utiliser que derrière un pare-feu qui réserve le port au reverse proxy. Une boucle locale seulement avec une `APP_URL` en http. |
| `TRUSTED_PROXIES` | Adresses IP ou plages CIDR des reverse proxies, séparées par des virgules, dont l'en-tête `X-Forwarded-For` est cru. |
| `GITHUB_API_URL` | API GitHub (défaut `https://api.github.com`), à changer pour GitHub Enterprise Server. |
| `GITHUB_SERVER_URL` | Serveur git des clones (défaut `https://github.com`) : un dépôt se clone depuis `<serveur>/<propriétaire>/<nom>.git`. |
| `MCP_LOG_DIR` | Répertoire des logs. Défaut : `<DATA_DIR>/logs`. |

Sans une variable obligatoire, ou avec une valeur invalide (`APP_URL` en http hors `localhost`, `AUTH_SECRET` trop court, `LISTEN_HOST` qui n'est pas une adresse IP), le serveur refuse de démarrer en nommant la variable.

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

Le gateway n'héberge que le mode MCP : clones, conteneurs Podman, Claude Code et appels à GitHub ont lieu sur la machine du serveur, qui doit joindre GitHub et le registre npm. Aucune route d'exécution (`GATEWAY_EXEC_ROUTES`) n'est nécessaire côté agent.

---

## Les outils

Six outils, en anglais, servis par le mode MCP. Le compte rendu d'une opération se termine par le lien vers son écran dans l'interface.

| Outil | Effet |
|---|---|
| `list_repositories` | Dépôts suivis non dépréciés, tous ou ceux d'une catégorie (`category`, son nom) : catégorie, tags, alertes Dependabot ouvertes par gravité (hors celles que l'utilisateur a corrigées à la main, comptées à part), paquets sans version corrigée au dernier audit, dernier audit sans vulnérabilité qui contredit les alertes, vulnérabilités trouvées par le dernier audit de la branche par défaut quand Dependabot ne signale rien, date de la dernière lecture (et son erreur), pull requests du tracker pas encore mergées, opération en cours. |
| `get_alerts` | Relit sur GitHub les alertes ouvertes d'un dépôt (`repository`) et les liste de la plus grave à la moins grave : numéro, gravité, paquet, écosystème, manifeste, portée de la dépendance (exécution ou développement), résumé, version corrigée, marque « corrigée à la main » de l'utilisateur, lien. |
| `run_audit` | Lance l'audit de chaque projet (`npm audit`, `pnpm audit`, `composer audit`) dans un clone temporaire de la branche analysée, sur le périmètre `scope` (`production` par défaut, ou `all`). Rien n'est modifié. Rend aussitôt l'identifiant de l'opération. |
| `fix_vulnerabilities` | Lance la même correction que le bouton « Corriger » de l'interface, sur le périmètre `scope` : audit, corrections automatiques, corrections par Claude s'il reste des vulnérabilités, puis commit, push et pull request vers la branche analysée. Avec `claude: false`, les corrections par Claude sont passées et seules les corrections automatiques sont poussées. Rend aussitôt l'identifiant de l'opération. |
| `get_operation` | État d'une opération (`operation`) : en cours, terminée, échouée ou annulée ; l'étape en cours (et, pendant les corrections par Claude, ses tours et ses dernières actions), les vulnérabilités avant et après, les paquets mis à jour, le résumé des corrections par Claude, leurs tests et leur tâche, la pull request, l'erreur. |
| `cancel_operation` | Annule une opération en cours (`operation`) : sa commande s'arrête, Claude Code compris, le clone est supprimé et rien n'est poussé. |

Un dépôt déprécié est refusé par tous les outils, jusqu'à ce que l'utilisateur le rétablisse. Un champ inconnu fait échouer l'appel. L'agent ne peut ni ajouter ni retirer de dépôt. Un token révoqué ferme aussitôt l'accès : chaque outil le dit.

---

## Une opération

Chaque opération travaille dans un clone temporaire (`<DATA_DIR>/clones/mcp-dependabot-tracker-*/repo`, `git clone --depth 1` de la branche analysée), supprimé dès qu'elle se termine, réussie, échouée ou annulée.

**Conteneurs** — chaque commande d'un gestionnaire de paquets tourne dans un conteneur Podman rootless créé pour elle et supprimé à sa fin (`podman run --rm`), à partir d'une image officielle (`docker.io/library/node:26-slim` pour npm et pnpm), ou d'une image construite par le tracker pour Composer : `localhost/mcp-dependabot-tracker/composer:php<version>`, faite de l'image officielle `docker.io/library/php:<version>-cli`, du binaire de `docker.io/composer/composer:2-bin`, de `git` et de `unzip`. La version de PHP suit `config.platform.php` du `composer.json` (la version que Composer suppose pour résoudre), sinon la plus ancienne des versions des images officielles (8.2 à 8.5) qui satisfait `require.php`, sinon la plus récente ; un projet qu'aucune ne satisfait fait échouer l'opération avec la raison. Au début de l'opération, le tracker vérifie que Podman est rootless, puis met chaque image à jour, une fois par opération (`podman pull`, ou `podman build --pull=newer`, qui reprend les couches déjà construites, à partir d'un dossier temporaire qui ne contient que le Containerfile) ; chaque conteneur l'utilise ensuite telle quelle (`--pull=never`). Quand une image a changé, sa version précédente est supprimée (`podman rmi`, qui emporte aussi ses couches devenues orphelines) : les mises à jour n'accumulent pas d'anciennes images sur le disque. Une version précédente encore utilisée par un conteneur est laissée, et le refus noté au journal de l'opération. Les caches de npm, de pnpm et de Composer, eux, vivent et meurent avec l'opération. Seuls le clone (`/work`, en écriture) et le cache de l'opération (`/cache`, à côté du clone) y sont montés : ni les données du tracker, ni les autres clones, ni aucun autre dossier du serveur. Le conteneur n'a aucune capacité (`--cap-drop=all`), ne peut pas gagner de privilèges (`no-new-privileges`), garde son système de fichiers en lecture seule hors de ces montages et d'un `/tmp` vide (`--read-only`), et tourne sous l'identité du compte du serveur (`--userns=keep-id`) : les fichiers qu'il écrit dans le clone lui appartiennent. Il ne reçoit aucune variable du serveur, hormis le proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) : ni token, ni secret. Le réseau reste ouvert pour le registre. pnpm est lancé par `npm exec --package=pnpm@<version> -- pnpm`, dans la version du champ `packageManager` du projet si elle sait auditer (pnpm 11 ou plus récent), en pnpm 11 sinon : l'API d'audit qu'interrogent les versions précédentes a fermé (`pnpm_config_pm_on_fail=ignore` empêche pnpm de basculer vers la version de `packageManager`). Une annulation ou un dépassement de délai supprime le conteneur (`podman rm --force`), qui survivrait sinon à l'arrêt du client `podman`.

La **branche analysée** se choisit par dépôt dans la GUI ; c'est la branche par défaut tant qu'aucune autre n'est choisie. L'agent l'utilise aussi, sans pouvoir en changer. Les alertes Dependabot, elles, portent toujours sur la branche par défaut, la seule que GitHub analyse : sur une autre branche, c'est `npm audit` qui mesure les vulnérabilités.

Le **périmètre** se choisit à chaque lancement d'une correction, d'un audit ou de « Auditer tout » : **production** (par défaut) laisse de côté les dépendances de développement (`--omit=dev` pour npm, `--prod` pour pnpm, `--no-dev` pour l'audit Composer) ; **toutes les dépendances** les couvre aussi. Chaque alerte Dependabot porte la portée de sa dépendance (`dependency.scope` de l'API GitHub : exécution ou développement). Un audit de production ne se compare qu'aux alertes qui ne portent pas sur une dépendance de développement ; une alerte de portée inconnue compte comme une alerte de production. Une opération enregistrée avant ce choix est lue comme un audit de toutes les dépendances.

1. **Cloner le dépôt** — puis repérer les projets : chaque dossier dont le lockfile d'un gestionnaire de paquets est suivi par git, `package-lock.json` pour npm (racine, `gui/`…), `pnpm-lock.yaml` pour pnpm, `composer.lock` pour Composer. Un workspace pnpm est un seul projet : ses paquets n'ont pas de lockfile à eux. Un dépôt peut mêler les gestionnaires (une API PHP et son interface npm) : une même opération les audite et les corrige tous. Un dépôt sans lockfile fait échouer l'opération. Un lockfile v1 de npm (npm 6) et un lockfile pnpm antérieur au format 9 sont refusés. Puis mettre à jour les images des conteneurs, ou construire celles des projets Composer.
2. **Audit** — dans chaque projet : `npm audit --json`, avec `--omit=dev` en production ; `pnpm audit --json`, avec `--prod` en production ; `composer audit --locked --format=json --no-scripts --no-plugins`, avec `--no-dev` en production. pnpm donne un avis par faille : le tracker en fait une vulnérabilité par paquet, avec la gravité la plus haute de ses avis ; la correction est « majeure » quand la plus petite version corrigée change la version majeure installée, absente quand aucune version corrigée n'est publiée. Composer ne donne que les versions touchées, sans version corrigée : la correction d'une vulnérabilité Composer est « inconnue », et un avis sans gravité compte comme `info`.
3. **Corrections automatiques** — dans chaque projet vulnérable, seuls les lockfiles (et, pour pnpm, les plages des `package.json`) changent, sans installation de `node_modules` ni script de paquet : `npm audit fix --package-lock-only --ignore-scripts` ; `pnpm audit --fix=update --lockfile-only --ignore-scripts`, avec `--prod` en production ; `composer update <paquets vulnérables> --with-all-dependencies --no-install --no-scripts --no-plugins --no-audit --ignore-platform-req=ext-*`, dans les contraintes de `composer.json` (les extensions PHP du projet ne changent pas la résolution, et l'image ne les a pas forcément). Quand Composer ne trouve aucune mise à jour possible dans ces contraintes (code de sortie 2), le journal le note et l'opération continue : il reste des vulnérabilités, comme quand `npm audit fix` n'en corrige pas. Puis un nouvel audit. Les commandes npm du tracker reçoivent `npm_config_allow_remote=all` : avec `--package-lock-only`, npm 12 refuse sinon les archives des paquets à `bundleDependencies` comme `@tailwindcss/oxide-wasm32-wasi` ([npm/cli#9800](https://github.com/npm/cli/issues/9800)). Ce réglage ne vaut que pour ces commandes, pas pour la configuration npm de la machine.
4. **Corrections par Claude** — pour une correction, dès que des vulnérabilités restent : la branche `fix/deps-audit-<AAAA-MM-JJ>-<HHMMSS>` (heure locale du serveur) est créée, les fichiers modifiés par les corrections automatiques y sont commités, puis Claude analyse et corrige en une session (voir [Les corrections par Claude](#les-corrections-par-claude)). Passées quand rien ne reste, et quand l'agent lance la correction avec `claude: false`. Un échec, Claude non configuré compris, laisse la correction se poursuivre avec les seules corrections de `npm audit fix`.
5. **Commit et push** — commit des fichiers modifiés sur la branche `fix/deps-audit-<AAAA-MM-JJ>-<HHMMSS>`, push, puis pull request vers la branche analysée, titrée du message de commit par défaut. Après les corrections par Claude, la branche porte déjà ses commits : seuls le push et la pull request restent à faire. Le corps de la pull request donne le périmètre et la commande exacte, les vulnérabilités avant et après, les paquets mis à jour et, le cas échéant, le résumé des corrections par Claude, fichier par fichier, avec le résultat des tests et la clé de sa tâche. Un avertissement en tête signale l'échec de Claude (la pull request ne porte alors que les corrections de `npm audit fix`) ou des tests en échec après ses corrections.

**Pull requests en attente** — à chaque lecture d'un dépôt (toutes les 10 minutes, ou « Synchroniser maintenant »), le tracker lit ses pull requests ouvertes sur GitHub et garde celles dont la branche suit le nommage `fix/deps-audit-<AAAA-MM-JJ>-<HHMMSS>` (ou `fix/npm-audit-…`, celui des versions précédentes) et appartient au dépôt lui-même (pas à une fourche). Les pull requests ouvertes avant cette fonction sont donc reconnues, même quand l'historique des opérations ne les contient plus. Une pull request mergée ou fermée disparaît à la lecture suivante, ou aussitôt quand l'utilisateur la marque mergée dans l'onglet « PR en attente » ; une pull request que le tracker vient d'ouvrir apparaît aussitôt.

**Auditer tout** — depuis l'accueil, un audit seul (clone et audit, sans correction) de la **branche analysée** (celle que clone une correction) de chaque dépôt suivi de l'onglet affiché : tous les dépôts sur « Tous mes projets » et « Dépréciés », ceux de la catégorie quand une catégorie est affichée (le bouton s'intitule alors « Auditer la catégorie »), ceux du tag quand un tag est affiché (« Auditer le tag »), ceux de la file d'attente sur son onglet (« Auditer la file »). Trois audits tournent à la fois. Un dépôt où une opération est déjà en cours est laissé de côté ; un audit qui échoue (dépôt sans lockfile, clone impossible) n'arrête pas les autres. La série vit dans le serveur ; une seule à la fois.

Les paquets mis à jour sont lus en comparant chaque lockfile à celui du commit cloné : version changée, paquet ajouté ou retiré. S'il n'y a rien à corriger, ou si les corrections ne changent rien, l'opération se termine sans push.

Depuis l'interface comme pour l'agent, une opération se lance aussitôt et va d'un bout à l'autre sans attendre de décision, dans le serveur, qu'on la suive ou non. Une seule opération à la fois par dépôt.

**Annulation** — l'annulation d'une opération en cours arrête aussitôt sa commande (arbre de processus compris, Claude Code compris) et supprime le clone ; rien n'est poussé. Une opération que l'arrêt du serveur a interrompue passe en échec au démarrage suivant, et son clone est supprimé.

---

## Les corrections par Claude

Quand les corrections automatiques laissent des vulnérabilités dans une correction, lancée depuis l'interface ou par un agent qui n'a pas passé `claude: false`, le tracker enchaîne sans attendre :

1. il crée la branche `fix/deps-audit-…` et y commite les fichiers modifiés par les corrections automatiques (premier commit, avec le message par défaut), s'ils ont changé ;
2. il lance une session Claude Code non interactive (`claude -p`) dans le clone, avec les vulnérabilités restantes (extraites du dernier audit, avec le gestionnaire de chaque projet) et la consigne propre à chaque gestionnaire du dépôt. Claude analyse chaque vulnérabilité dans le code (usage du paquet, faille atteignable ou non, urgence), monte ou épingle les dépendances (`package.json` et ses `overrides`, `overrides` de `pnpm-workspace.yaml`, contraintes de `composer.json`, puis mise à jour du lockfile), adapte le code, relance l'audit, installe les dépendances et lance les tests, par les outils du tracker ;
3. Claude rédige son rapport, en français : l'analyse de chaque paquet vulnérable, chaque changement fichier par fichier et sa raison, le résultat de l'audit et des tests (un avertissement en tête quand ils échouent), et ce qui reste à corriger ou à vérifier à la main. Avec un organizer réglé, ce rapport est **une seule tâche** « Rapport de correction — … » de l'espace, assignée à son propriétaire et taguée du nom du dépôt ; l'organizer est facultatif : sans lui, le rapport rejoint la pull request, dans un bloc repliable « Rapport de Claude ». Claude rend un rapport structuré (`--json-schema`) : clé de la tâche (avec l'organizer) ou rapport détaillé (sans), résumé, fichiers modifiés, message de commit, résultat des tests ;
4. le tracker vérifie la tâche, avec l'organizer (assignée, taguée), commite les changements de Claude (second commit, au message proposé par Claude, avec `Co-Authored-By: Claude`), sans les `node_modules` ni le `vendor` des projets Composer, relance `npm audit`, puis pousse la branche et ouvre la pull request.

Une tâche introuvable, sans le tag ou non assignée au propriétaire fait échouer la session, comme une erreur de Claude, un dépassement des limites, le token Claude non réglé, ou un bac à sable impossible : le clone revient au commit des corrections automatiques, l'erreur s'affiche sous l'étape, et la correction pousse quand même les corrections automatiques, avec un avertissement en tête de la pull request. L'annulation de l'opération arrête Claude Code.

**Ce que Claude peut faire** — outils intégrés `Read`, `Grep`, `Glob`, `Edit` et `Write`, sans shell : ni `git`, ni push. `Edit` et `Write` refusent tout chemin hors du clone (`blockWritesOutsideWorkingDirectories`). Le clone n'a pas de dossier `.git` : le dépôt git de l'opération est à côté de lui (`GIT_DIR`), hors de portée de Claude et des commandes npm, et le tracker lance `git` sans hook (`core.hooksPath`) ni moniteur de fichiers (`core.fsmonitor`) ; un hook posé dans le clone par un paquet (husky…) ou par un script d'installation ne s'exécute donc jamais sur le serveur. Claude lance les gestionnaires de paquets par les outils d'un second serveur MCP, `packages`, que le tracker lui fournit (`dist/src/package-tools.js`) avec les seuls outils des gestionnaires des projets du dépôt, et avec les variables système du serveur (`HOME`, `XDG_RUNTIME_DIR`, `PATH`, proxy), qui remplacent celles de Claude Code : Podman rootless y retrouve le stockage du compte du serveur, où sont ses images ; pour npm : `npm_install_lockfile` (`npm install --package-lock-only --ignore-scripts`, avec les paquets à ajouter ou monter), `npm_audit` (avec le périmètre de l'opération), `npm_ci`, `npm_test`, `npm_run` (un script de `package.json`), `npm_ls` et `tsc` (`npm exec --no -- tsc --noEmit`) ; pour pnpm : `pnpm_install_lockfile` (`pnpm install --lockfile-only --ignore-scripts`), `pnpm_audit`, `pnpm_install` (`--frozen-lockfile`), `pnpm_test` (`pnpm -r --if-present run test`), `pnpm_run` (un script, à la racine ou dans un paquet du workspace avec `--filter`) et `pnpm_why` (`pnpm why -r`) ; pour Composer : `composer_update_lock` (`composer update <paquets> --with-all-dependencies --no-install --no-scripts --no-plugins --ignore-platform-req=ext-*`, paquets obligatoires), `composer_audit`, `composer_install`, `composer_test` (`composer run-script test`), `composer_run` (un script de `composer.json`) et `composer_why` (`composer depends --locked --tree`). L'image n'a que les extensions par défaut de l'image officielle de PHP : une extension manquante à l'installation ou aux tests est signalée dans le rapport, pas corrigée. Chaque outil lance une commande fixe dans un dossier du clone qui contient un `package.json` ; ses arguments ne sont que des noms de paquets ou de scripts. Le bac à sable de Claude Code garde en lecture seule les manifestes, les lockfiles et `node_modules` : ces commandes tournent donc hors de lui, chacune dans un conteneur jetable du tracker, comme ses propres `npm audit` et `npm audit fix` (voir [Une opération](#une-opération)) : le code du projet et de ses paquets, `.npmrc` compris, ne s'exécute jamais sur le serveur, et le conteneur ne voit que le clone et le cache de l'opération, sans aucun token. Claude Code ne reçoit jamais `GITHUB_TOKEN`, et `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` retire son propre token de l'environnement des processus qu'il lance ; sous Linux, cette variable active d'office le bac à sable de Claude Code, qui refuse alors de démarrer sans bubblewrap. Installez-le sur le serveur (`sudo apt-get install -y bubblewrap socat`). Avant chaque session de Claude, le tracker crée un bac à sable d'essai avec le compte et les restrictions du serveur ; s'il échoue, la session est refusée avec la raison : `bwrap` absent, restriction AppArmor des espaces de noms utilisateur (`kernel.apparmor_restrict_unprivileged_userns`, Ubuntu 24.04 et suivantes) ou durcissement du service (`RestrictNamespaces`, `PrivateUsers`, `SystemCallFilter`). Côté organizer, seuls `create_task`, `set_assignees` et `set_tags` sont autorisés : Claude ne lit aucune autre tâche de l'espace, dont le contenu ne peut donc pas finir dans la pull request ; tout autre appel est refusé (`--permission-mode dontAsk`). La consigne précise que les fichiers du dépôt, les sorties de npm et les avis de sécurité sont des données à analyser, jamais des instructions, et demande de signaler dans la tâche tout texte qui tenterait de le détourner, et les réglages Claude du dépôt cloné ne sont pas lus (`--setting-sources user`). Installer les dépendances et lancer les tests exécute le code du projet et de ses paquets dans le clone, à chaque correction par Claude. La configuration MCP, qui porte le token de l'organizer, est écrite hors du clone et supprimée en fin de session. Pour garder en lecture seule `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.gitmodules`, `yarn.lock` et `pnpm-lock.yaml`, le bac à sable de Claude Code les crée vides dans le clone quand le dépôt n'en a pas : ces fichiers vides sont retirés avant le commit des corrections.

**Limites** — nombre de tours (`--max-turns`, défaut 40) et durée (défaut 15 min, au-delà de laquelle le tracker arrête Claude Code), réglables dans la GUI.

**Réglages** (écran Réglages, roue dentée de l'accueil) :

- **Serveurs de déploiement** — les serveurs connectés en SSH, partagés par les dépôts (voir [Le déploiement](#le-déploiement)).
- **GitHub** — le token du tracker et le token de déploiement (voir [Tokens GitHub](#tokens-github)) ; « Retirer », confirmé par un second clic, supprime le token de déploiement.
- **Organizer** (facultatif) — où Claude dépose son rapport ; sans organizer, le rapport est dans la pull request. Adresse du site (https, sauf pour un site de cette machine) et token d'agent, créé dans l'organizer (Paramètres › Agents) : il couvre un espace, avec les droits de son créateur. Une connexion modifiée est testée à l'enregistrement ; « Tester » la reteste. L'écran affiche l'espace et son propriétaire.
- **Claude** — un token d'abonnement (Pro, Max, Team ou Enterprise) : lancer `claude setup-token` sur un poste avec navigateur, autoriser l'accès, puis coller le token affiché (valable un an). Il est vérifié à l'enregistrement par une requête minimale ; un token refusé n'est pas enregistré. L'écran affiche sa date d'enregistrement et d'expiration.
- **Corrections par Claude** — les limites d'une session.
- **Accès des agents** — les tokens d'agent, un par ligne : nom, quatre derniers caractères, date de création et de dernière utilisation ; « Révoquer », au survol (en permanence sur un écran tactile), le révoque après un second clic de confirmation dans les 4 secondes. « Nouveau token » ouvre un champ en place pour le nommer (Entrée crée, Échap annule) ; le token s'affiche alors une seule fois, avec « Copier » et la commande `--claude-setup-mcp` qui déclare le mode MCP. Créer ou révoquer un token prend effet aussitôt, sans « Enregistrer ».

Les tokens GitHub, de l'organizer et de Claude sont enregistrés dans `<données>/settings.json`, chiffrés avec `VAULT_KEY` (un fichier écrit en clair par une version antérieure est chiffré au démarrage), ceux des agents par leur empreinte dans `<données>/agent-tokens.json`, lisibles par le seul compte du serveur ; la GUI n'en reçoit que les quatre derniers caractères. Claude Code garde sa configuration dans `<données>/claude`. L'écran est protégé comme le reste de l'interface, par la session de l'utilisateur.

**Suivi** — la tâche du dernier rapport de Claude s'affiche dans la colonne « Suivi » de la ligne du dépôt (« MNT-12 », qui ouvre la tâche sur l'organizer) tant qu'elle n'est pas terminée : son statut est relu sur l'organizer avec les alertes, toutes les 10 minutes. La pull request de la correction mentionne la clé de la tâche.

---

## Le déploiement

Chaque dépôt peut se déployer sur un serveur, par SSH, avec un script shell écrit dans l'interface (onglet « Déploiement » de l'écran du dépôt).

**Serveurs** — les serveurs se gèrent dans les Réglages, section « Serveurs de déploiement », et se partagent entre dépôts. Chaque ligne donne le nom du serveur, `utilisateur@hôte:port`, le nombre de dépôts qui le choisissent et son état (« Connecté », « À tester », « Clé révoquée ») ; son menu « … » propose Modifier, Tester la connexion (ou Installer une clé, sans clé), Changer de clé, Révoquer la clé et Supprimer. Un serveur ne se supprime que si aucun dépôt ne le choisit et qu'il n'a plus de clé.

Dans l'onglet « Déploiement » d'un dépôt, le nom du serveur ouvre la liste des serveurs : un clic choisit celui du dépôt (un serveur sans clé n'est pas proposé), « Ne plus déployer ce dépôt » le détache, et un lien mène aux Réglages. Un dépôt sans serveur affiche « Choisir un serveur ». Changer de serveur est refusé pendant un déploiement.

**Connexion d'un serveur** — « Ajouter un serveur », dans les Réglages, suit la même procédure que [SSH Gate](https://www.npmjs.com/package/@imenam/mcp-ssh-gate), en trois étapes :

1. **Serveur** — nom, hôte, port et utilisateur. « Générer la clé » enregistre le serveur avec sa propre paire ed25519 (`dependabot-tracker@<serveur>`). La clé privée est chiffrée avec `VAULT_KEY` et n'est jamais affichée.
2. **Installation** — une commande d'une ligne, à coller dans une session ouverte sur le serveur avec l'utilisateur choisi. Elle écrit la clé dans le fichier dédié `~/.ssh/authorized_keys.d/dependabot-tracker` (ligne `restrict` : ni redirection, ni agent, ni pseudo-terminal), fait lire ce fichier à sshd en plus de `~/.ssh/authorized_keys` (`/etc/ssh/sshd_config.d/10-dependabot-tracker.conf`, avec sudo), et ne recharge sshd que si sa configuration est valide et prend le fichier en compte ; sinon le réglage est retiré. `~/.ssh/authorized_keys` n'est jamais modifié. Le réglage nomme aussi le fichier de SSH Gate : sshd ne retenant que le premier `AuthorizedKeysFile`, un serveur où les deux sont installés garde l'accès de SSH Gate. « Clé publique seule » affiche la clé, pour l'installer autrement.
3. **Test** — le tracker se connecte, enregistre l'empreinte de la clé d'hôte (vérifiée à chaque connexion suivante : une clé d'hôte changée refuse la connexion), puis limite la ligne de sa clé à son adresse vue par le serveur (`from="…"`, lue dans `$SSH_CLIENT`). La nouvelle ligne est vérifiée par une seconde connexion avant d'être gardée ; refusée, la ligne d'origine est remise. Les lignes des autres clés du fichier ne sont pas touchées. Le résultat dit si la clé est bien dans le fichier dédié, limitée à une adresse, et signale une copie restée dans `~/.ssh/authorized_keys`.

Modifier l'hôte ou le port d'un serveur oublie son empreinte et son test.

**Renouveler la clé** — comme dans SSH Gate, en quatre étapes : générer une nouvelle paire, ajouter sa ligne à côté de l'actuelle dans le fichier dédié (avec la même limite d'adresse), ouvrir une seconde connexion avec la nouvelle clé, puis ne garder qu'elle. Un échec avant la dernière étape remet le fichier dans son état d'origine et garde la clé actuelle : rien n'est perdu. Refusé tant que la connexion n'a pas été testée, quand la clé n'est pas dans le fichier dédié, ou quand elle figure aussi dans `~/.ssh/authorized_keys` (elle y resterait valable).

**Révoquer la clé** — le tracker retire sa ligne du fichier dédié (les autres lignes restent), vérifie qu'une nouvelle connexion est refusée, puis efface la clé : le serveur reste enregistré, « Clé révoquée ». Si le serveur accepte encore la clé, elle figure ailleurs et rien n'est effacé. Si le tracker ne peut pas se connecter, la fenêtre donne la commande qui retire la ligne, à lancer soi-même, puis « C'est fait, effacer la clé » l'oublie sans toucher au serveur. « Installer une clé » (menu « … » du serveur, dans les Réglages) génère une nouvelle paire et rouvre l'assistant sur sa commande d'installation.

Le renouvellement et la révocation valent pour tous les dépôts qui utilisent le serveur, et sont refusés pendant un déploiement sur ce serveur.

**Script** — en bash, édité dans l'interface avec coloration syntaxique (la palette « sobre » de SSH Gate), numéros de ligne et ligne du curseur surlignée ; Tab indente, Ctrl+S enregistre, Échap annule. Le tracker définit trois variables : `$BRANCH` (la branche analysée du dépôt), `$COMMIT` (son dernier commit sur GitHub, lu au lancement) et `$REPO` (`propriétaire/nom`). Avec un token de déploiement réglé, il définit aussi les variables qui authentifient `git` (voir ci-dessous).

**Déploiement** — « Déployer », actif quand le serveur est testé et le script écrit, lance le script sur le serveur et le suit en direct. Le script est copié dans un dossier temporaire du serveur (`mktemp -d`, supprimé à la fin), puis exécuté avec bash depuis le dossier personnel, l'entrée venant de `/dev/null` ; sa sortie (stdout et stderr) s'affiche au fil de l'eau, et sa ligne en cours est lue dans la trace de bash (`set -x`, sur un descripteur à part : la sortie n'en contient rien). Un déploiement réussi (code 0) retire la marque « à déployer » du dépôt ; un échec donne le code de sortie et la ligne du script en cours. « Interrompre » envoie SIGTERM à tout le groupe de processus du script, puis ferme la connexion. Un seul déploiement à la fois par dépôt ; le retrait d'un dépôt est refusé pendant un déploiement. Un déploiement que l'arrêt du serveur a interrompu passe en échec au démarrage suivant. Les 20 derniers déploiements de chaque dépôt sont conservés, avec le script lancé et la sortie (ses 200 000 derniers caractères).

**Accès au code des dépôts privés** — le `git pull` d'un script de déploiement doit s'authentifier auprès de GitHub pour un dépôt privé ; lancé par le tracker, il n'a ni terminal ni assistant d'identifiants (celui de VS Code n'existe que dans ses sessions). Le tracker lui fournit un **token de déploiement**, réglé une fois dans les Réglages : un token à grain fin en **lecture seule** (permission *Contents* : *Read-only*, *Metadata* imposée), limité aux dépôts déployés (*Only select repositories*). Un dépôt s'y ajoute en modifiant le token sur GitHub : sa valeur ne change pas, rien n'est à refaire. Ce n'est jamais le token du tracker, qui écrit sur les dépôts et ne quitte pas le processus du tracker.

À chaque déploiement, le tracker relit le token et l'exporte dans l'environnement du script sous forme de réglage git (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` = `http.<serveur GitHub>/.extraheader`, `GIT_CONFIG_VALUE_0` = en-tête `AUTHORIZATION`), avec `GIT_TERMINAL_PROMPT=0` : un simple `git pull` sur un remote https s'authentifie sans autre réglage, et un échec d'authentification est immédiat. Ces variables sont exportées avant le début de la trace de bash : le token n'apparaît ni dans la trace, ni dans le script enregistré. Rien n'est écrit sur le serveur cible : ni token, ni `~/.git-credentials`, ni configuration git, et les sessions VS Code ne sont pas touchées.

Tout processus lancé par le script hérite de ces variables, `npm ci` compris : retirez-les juste après le `git pull`, pour ne pas les transmettre aux commandes suivantes. Ce n'est pas une barrière étanche : l'environnement de départ du script reste lisible dans `/proc/<pid>/environ`, et du code qui tourne en root lit tout le serveur. La sécurité repose sur les droits du token : en lecture seule, limité à des dépôts dont le code est déjà sur le serveur cible, un token volé n'ouvre rien de plus.

```bash
git pull
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
npm ci
```

Le déploiement se pilote depuis l'interface seulement : les outils de l'agent n'y ont pas accès.

---

## L'interface

Thème sombre, une information par ligne, une action principale par écran.

- **Accueil (`#/`, `#/c/<catégorie>`, `#/t/<tag>`)** — à gauche, la barre des catégories : « Tous mes projets », « File d'attente » avec le nombre de dépôts qu'elle contient, « PR en attente » avec le nombre de dépôts dont une pull request du tracker attend, « À déployer » avec le nombre de dépôts marqués, puis chaque catégorie, chacune avec le nombre d'alertes ouvertes de ses dépôts, coloré selon la plus grave (aucune pastille sans alerte), précédé du nombre de pull requests du tracker en attente (aucune pastille sans pull request). « Nouvelle catégorie » ouvre un champ en place (Entrée crée, Échap annule) ; au survol d'une catégorie, « … » propose de la renommer ou de la supprimer (un second clic confirme ; ses dépôts restent suivis, sans catégorie). Un dépôt appartient à une catégorie au plus. Sous les catégories, la section « Tags » liste les tags portés par les dépôts non dépréciés, avec les mêmes pastilles ; un clic n'affiche que les dépôts qui portent ce tag, son nom en titre. Un tag n'existe que tant qu'un dépôt le porte. En bas de la barre, « Dépréciés » ouvre l'onglet des dépôts dépréciés, avec leur nombre.
  À droite, les dépôts non dépréciés de la catégorie choisie, du plus exposé au moins exposé (gravité la plus haute, puis nombre de vulnérabilités). L'interrupteur « Vulnérables seulement » ne garde que les dépôts réellement vulnérables : des paquets sans version corrigée au dernier audit, des alertes non corrigées à la main que le dernier audit ne contredit pas, ou des vulnérabilités trouvées par l'audit alors que Dependabot ne signale rien ; le navigateur retient sa position. Les dépôts forment un tableau à en-tête, une ligne par dépôt : le nom (`propriétaire/dépôt` en infobulle), suivi au survol d'une icône qui ouvre sa page GitHub dans un nouvel onglet (en permanence sur un écran tactile), puis de ses tags (celui de l'onglet affiché mis en avant) et, au survol (en permanence sur un écran tactile), d'un bouton « + ». Ce bouton ouvre le menu des tags du dépôt : le champ filtre les tags existants, chacun avec une case et son nombre de dépôts ; un nom inconnu propose « Créer « … » ». ↑ ↓ et Entrée ou un clic cochent et décochent, Échap ferme ; chaque changement s'enregistre aussitôt. Un nom déjà porté par un autre dépôt, à la casse près, reprend son écriture. La colonne du nom prend en priorité la largeur du plus long nom, qui s’affiche en entier jusqu’à 420 px. Viennent ensuite les colonnes « Sécurité », « Dernier audit » et « Suivi », qui se partagent la place restante, puis les boutons et le chevron. Un contenu trop long est coupé, jamais poussé sur la colonne voisine, et l'infobulle le donne en entier.
  **Sécurité** — la pastille des alertes Dependabot non corrigées à la main, colorée selon la plus grave. Elle est estompée quand le dernier audit de la branche par défaut, plus récent que chacune d'elles, n'a trouvé aucune vulnérabilité : Dependabot n'a pas encore repassé. Elle est suivie de « dév. » quand toutes portent sur des dépendances de développement et que le dernier audit de production de la branche par défaut n'a rien trouvé. Des alertes toutes marquées corrigées à la main gardent une pastille estompée et ne comptent plus, ni ici, ni dans la barre des catégories. Sans alerte Dependabot, une pastille « N vulnérabilités » reprend ce qu'a trouvé le dernier audit de la branche par défaut, que Dependabot n'a pas encore vu ; ces vulnérabilités comptent dans la barre des catégories comme les alertes. « à la main » (icône de clé) signale les paquets pour lesquels le dernier audit n'a trouvé aucune version corrigée publiée, listés en infobulle. Sinon, la cellule affiche « Synchronisation impossible » (l'erreur en infobulle), « Synchronisation… » avant la première lecture, ou « — ».
  **Dernier audit** — l'opération en cours (« Audit en cours », « Correction en cours », « Corrections par Claude… »), sinon « Audit en échec » et sa date quand la dernière opération a échoué avant d'avoir audité (clone ou audit ; l'erreur en infobulle) : un audit réussi plus ancien ne la masque pas. Sinon le résultat du dernier audit, quelle que soit sa branche, et sa date : « OK », « Prod. OK » pour un audit des seules dépendances de production, ou « N vulnérabilités » ; le périmètre et la branche sont en infobulle. Pour une correction qui a ouvert une pull request, c'est l'audit qui suit ses corrections, sur la branche de la pull request : la colonne montre tout de suite ce qu'il restera après la fusion. « — » sans audit.
  **Suivi** — des marqueurs discrets, chacun avec son infobulle : la pull request du tracker en attente (« #42 », ou « 2 PR », qui ouvre la liste des pull requests du dépôt), la tâche organizer du dernier rapport de Claude tant qu'elle n'est pas terminée (« MNT-12 », qui ouvre la tâche), la file d'attente et la marque « à déployer », leur date en infobulle.
  Les boutons de la ligne n'apparaissent qu'au survol, et en permanence sur un écran tactile. Le dernier, avant le chevron (icône archive), marque le dépôt **déprécié** (refusé pendant une opération). Un dépôt déprécié n'est plus synchronisé ni audité (ni par la relecture des 10 minutes, ni par « Synchroniser maintenant » et « Auditer tout », ni par l'agent), ne compte dans aucune pastille et quitte sa catégorie à l'affichage tout en la gardant. Le marquer déprécié le retire aussi de la file d'attente et lui retire la marque « à déployer ».
  Juste avant, un bouton (icône de fusée) marque le dépôt **à déployer**, pour un dépôt sans déploiement automatique dont la correction reste à déployer : il reste allumé tant que le dépôt est marqué, et un nouveau clic retire la marque.
  Avant ces boutons, un autre (icône de liste) met le dépôt dans la **file d'attente** ; il reste allumé tant que le dépôt y est, et un nouveau clic l'en retire. Dans une catégorie, « Tout ajouter à la file », à côté de l'interrupteur, y met d'un coup tous ses dépôts qui n'y sont pas encore (inactif quand ils y sont tous).
  « Ajouter un dépôt » ouvre une fenêtre avec un champ de recherche et la catégorie. Dès la première lettre, jusqu'à dix dépôts accessibles au token et pas encore suivis sont proposés (ceux dont le nom commence par la saisie d'abord) ; ↑ et ↓ parcourent, Entrée ou un clic reportent le dépôt dans le champ, Échap referme la liste, puis la fenêtre. La catégorie part de celle affichée. « Ajouter » valide ; sans suggestion, Entrée aussi. La saisie peut être `propriétaire/dépôt` ou un lien GitHub.
  Dans la colonne « Suivi », « #42 » ouvre la pull request sur GitHub, « 3 PR » la liste des pull requests du dépôt.
  « Synchroniser maintenant », à côté, relit tout de suite les alertes et les pull requests de tous les dépôts, sans attendre la relecture des 10 minutes ; l'icône tourne jusqu'à la fin. « Auditer tout » audite la branche analysée de tous les dépôts (voir plus haut) : un clic l'audite en production, la flèche à côté propose « Production » ou « Toutes les dépendances » ; le bouton affiche la progression (« Audit 4/12… »), chaque dépôt audité affiche « Audit en cours », et un message final donne le nombre de dépôts audités, laissés de côté et en échec (avec leurs noms).
  La roue dentée, à gauche de « Synchroniser maintenant », ouvre les réglages.
- **File d'attente (`#/queue`)** — les dépôts mis en file, non dépréciés, dans l'ordre de leur entrée dans la file, avec les mêmes informations et le même interrupteur que l'accueil. Le chevron ouvre le dépôt pour l'auditer ou le corriger. « Traité », sur chaque ligne, retire le dépôt de la file sans toucher à sa catégorie.
- **PR en attente (`#/pulls`)** — les dépôts non dépréciés dont une pull request du tracker attend d'être mergée, de la plus ancienne à la plus récente, avec l'interrupteur de l'accueil. Une correction aboutie y place son dépôt dès l'ouverture de sa pull request. Sur chaque ligne, « Mergée » retire aussitôt le dépôt de l'onglet, pour un dépôt au déploiement automatique ; « Mergée, à déployer » le fait passer en plus dans « À déployer ». Les deux lancent aussitôt, en arrière-plan, un audit de la branche par défaut, sur le périmètre de la correction qui a ouvert la pull request : la liste reflète la branche fusionnée sans attendre que Dependabot repasse. Ils sont refusés tant qu'une opération est en cours sur le dépôt. La relecture des 10 minutes retire aussi les pull requests mergées ou fermées sur GitHub ; une pull request marquée mergée mais encore ouverte sur GitHub y revient à la lecture suivante.
- **À déployer (`#/deploy`)** — les dépôts marqués « à déployer », non dépréciés, dans l'ordre où ils ont été marqués, avec les colonnes de l'accueil (la date de la marque en infobulle de la fusée) et son interrupteur. Le chevron ouvre le dépôt. « Déployé », sur chaque ligne, retire la marque sans toucher à sa catégorie ni à la file d'attente.
- **Réglages (`#/settings`)** — serveurs de déploiement, tokens GitHub, connexion à l'organizer, token Claude, limites des corrections par Claude et tokens d'accès des agents (voir [Les corrections par Claude](#les-corrections-par-claude)). Un token enregistré n'apparaît que par ses quatre derniers caractères, avec « Remplacer ». « Enregistrer » valide les tokens, l'organizer et les limites ; les serveurs et les tokens d'agent se créent, se modifient et se suppriment aussitôt.
- **Dépréciés (`#/deprecated`)** — les dépôts dépréciés, du plus récent au plus ancien, avec la date de dépréciation. « Rétablir », sur chaque ligne, remet le dépôt dans sa catégorie et relit aussitôt ses alertes. Le chevron ouvre l'écran du dépôt, où « Corriger » est désactivé.
- **Dépôt (`#/r/<propriétaire>/<nom>`, `#/r/<propriétaire>/<nom>/history`)** — le nom du dépôt, suivi d'une icône qui ouvre sa page GitHub dans un nouvel onglet (sur le serveur de `GITHUB_SERVER_URL`), sélecteur de la branche analysée (un clic ouvre la liste des branches avec un champ de recherche, la branche par défaut en tête ; ↑ ↓ et Entrée ou un clic choisissent, Échap ferme), sélecteur de la catégorie (« Sans catégorie » ou l'une des catégories) et date de la dernière lecture des alertes, puis trois onglets. **Alertes ouvertes**, avec leur nombre : les alertes ouvertes (gravité, paquet, résumé), chacune ouvrant l'alerte sur GitHub. Une alerte dont le paquet n'a aucune version corrigée publiée porte « ⚠ sans correctif », une alerte sur une dépendance de développement l'étiquette « dév. ». Au survol d'une alerte, « Corrigée à la main » la range dans la section « Corrigées à la main », avec la date du marquage ; « Rétablir » la remet à traiter. Dependabot continue souvent de signaler une alerte corrigée à la main (un paquet installé hors du registre npm, par exemple) : la marque tient tant que l'alerte reste ouverte, et tombe à la lecture suivante si Dependabot émet une nouvelle alerte sur le même paquet. **Historique**, avec le nombre d'opérations : une ligne par opération conservée (les 20 dernières du dépôt), de la plus récente à la plus ancienne, avec audit ou correction, qui l'a lancée, le périmètre, la branche, la date, les vulnérabilités avant et après (le début de l'erreur pour une opération échouée), la part de Claude (« Claude » quand il a été lancé) et l'issue (la pull request, « terminée », « annulée », « échouée ») ; chaque ligne ouvre l'opération. **Déploiement** (`…/deploy`) : sans serveur, « Choisir un serveur » ouvre la liste des serveurs des Réglages. Avec un serveur : sa ligne (le nom, qui ouvre la même liste pour changer de serveur ou ne plus déployer ce dépôt, l'adresse, le dernier déploiement, « Connecté », « À tester » ou « Clé révoquée », ces deux dernières menant aux Réglages, et « Déployer »), le script coloré avec « Modifier », puis les derniers déploiements (branche, commit, date, durée, issue), chacun ouvrant son détail (`…/deploy/<id>`) : le script avec la ligne en échec surlignée et la sortie. Pendant un déploiement, l'onglet montre son exécution : la ligne en cours surlignée, les suivantes estompées, la sortie qui défile, et « Interrompre » à la place de « Déployer ». « Corriger » lance une correction en production ; la flèche à côté ouvre le choix du périmètre (« Production » ou « Toutes les dépendances », Échap ferme). « Voir la correction en cours » rouvre celle en cours. À gauche de la corbeille, « Traité » retire de la file d'attente un dépôt qui y est et ramène à la file ; pour un dépôt hors de la file, « Ajouter à la file » l'y met (absent pour un dépôt déprécié). Juste avant, « À déployer » marque le dépôt ; une fois marqué, le bouton s'allume et devient « Déployé », qui retire la marque (absent pour un dépôt déprécié). La corbeille retire le dépôt du suivi : elle devient « Confirmer le retrait », qu'un second clic dans les 4 secondes confirme ; refusé pendant une opération.
- **Correction (`#/r/<propriétaire>/<nom>/op/<id>`)** — qui l'a lancée (vous ou l'agent), la branche clonée, le périmètre ; les flèches « 1 / 5 » passent à l'opération plus récente ou plus ancienne du dépôt, la flèche de retour ramène à son historique. Trois onglets : **Étapes**, **Claude** (quand Claude est intervenu) et **Journal**. Les étapes se suivent sans décision à prendre : chacune tient sur une ligne avec son résultat (« 4 vulnérabilités », « 3 corrigées », lien vers la pull request). Une étape passée en donne la raison : « rien à corriger » quand les corrections automatiques ont tout corrigé, « rien à pousser » quand les corrections n'ont rien changé, « ignorée » sinon. Les vulnérabilités sans aucune version corrigée publiée (pour npm, `fixAvailable: false`, par exemple `xlsx`, que SheetJS ne publie plus sur npm ; pour pnpm, aucune version corrigée dans l'avis) sont comptées sur la ligne du dernier audit (« 1 sans correctif ») ; un clic les liste avec leur gravité : leur mise à jour est à faire à la main. Pendant les corrections par Claude, l'étape montre leur durée, leurs tours et les trois dernières actions de Claude ; ensuite, ce qu'il a changé : résumé, fichiers, tests, vulnérabilités restantes et lien vers sa tâche de rapport. Un échec de Claude s'affiche sous l'étape (« échouées · corrections automatiques seules »). Une fois la pull request ouverte, l'étape du push montre la branche et « voir les changements » (paquets mis à jour, replié) ; tant que la pull request attend, elle propose aussi « Mergée » et « Mergée, à déployer », comme l'onglet « PR en attente ». Une erreur s'affiche sous l'étape qui a échoué. L'onglet « Claude » montre la session : sa tâche de rapport, le déroulé complet de ses messages et de ses actions (500 derniers) et son résultat : le résumé des corrections, les fichiers modifiés, le commit, les tests et les vulnérabilités restantes, ou la raison de l'échec. L'onglet « Journal » montre les commandes lancées et leurs résultats ; « Annuler » arrête l'opération.

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
| `GET /api/audit-all`, `POST /api/audit-all` | État de la dernière série « Auditer tout » (`null` si aucune depuis le démarrage) : en cours ou non, dépôts traités sur le total, laissés de côté, en échec avec la raison ; lancement d'une série sur le périmètre `scope` du corps (`production` ou `all`) et les dépôts de `target` : `{ "kind": "all" }`, `{ "kind": "category", "categoryId": … }`, `{ "kind": "tag", "tag": … }` ou `{ "kind": "queue" }` (`404` si la catégorie n'existe pas, `409` si une série est en cours). |
| `GET /api/github/repos` | Dépôts accessibles au token (`/user/repos`) et pas encore suivis, pour les suggestions d'ajout. |
| `GET` / `DELETE /api/repos/:propriétaire/:nom` | Dépôt ; retrait. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/deprecated` | Marque le dépôt déprécié (`409` pendant une opération) et lui retire la file d'attente et la marque « à déployer » ; le rétablit et relit ses alertes. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/queued` | Met le dépôt dans la file d'attente (`409` pour un dépôt déprécié ; sans effet s'il y est déjà) ; l'en retire. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/deploy-pending` | Marque le dépôt « à déployer » (`409` pour un dépôt déprécié ; sans effet s'il l'est déjà) ; retire la marque. |
| `PUT /api/repos/:propriétaire/:nom/merged` | Retire les pull requests en attente du dépôt, que l'utilisateur dit mergées (`{ deploy }` : avec `true`, le dépôt passe aussi « à déployer » ; `409` pour un dépôt déprécié). |
| `GET /api/repos/:propriétaire/:nom/branches`, `PUT …/branch` | Branches du dépôt, la branche par défaut en tête ; choix de la branche analysée (`{ branch }`, qui doit exister). |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/alerts/:numéro/handled` | Marque une alerte ouverte corrigée à la main ; retire la marque. |
| `PUT /api/repos/:propriétaire/:nom/category` | Catégorie du dépôt (`{ categoryId }`, null pour aucune). |
| `PUT /api/repos/:propriétaire/:nom/tags` | Tags du dépôt (`{ tags }`, 20 au plus, 30 caractères chacun), qui remplacent les précédents ; sans doublon à la casse près, dans l'ordre alphabétique. |
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
| `GET /api/deploy-servers`, `POST /api/deploy-servers` | Serveurs de déploiement, avec la commande d'installation de leur clé et le nombre de dépôts qui les choisissent ; création (`{ name, host, port, username }`), qui génère la paire de clés. |
| `PUT /api/deploy-servers/:id` | Modifie un serveur ; un nouvel hôte ou port oublie son empreinte et son test. |
| `DELETE /api/deploy-servers/:id` | Supprime un serveur (`409` tant qu'un dépôt le choisit, qu'il a une clé ou qu'un déploiement y tourne). |
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

`<données>/repos.json` pour les catégories et les dépôts (catégorie, tags, alertes, alertes corrigées à la main, dernière lecture, date de dépréciation), `<données>/operations/<id>.json` pour chaque opération (session de Claude comprise) ; les 20 plus récentes sont conservées par dépôt. `<données>/settings.json` porte les réglages des corrections par Claude et leurs tokens, `<données>/agent-tokens.json` les tokens d'agent, dont seule l'empreinte SHA-256 est conservée ; les deux fichiers ne sont lisibles que par le compte du serveur. `<données>/claude` garde la configuration de Claude Code. `<données>/deploy-servers.json` porte les serveurs de déploiement, leur clé privée chiffrée avec `VAULT_KEY`, lisible par le seul compte du serveur ; `<données>/deployments/<id>.json` chaque déploiement, les 20 plus récents par dépôt. Le serveur et le script de déploiement d'un dépôt sont dans `repos.json`. Le serveur est le seul processus qui écrit ces fichiers ; chaque écriture est atomique. Une opération enregistrée par une version qui attendait une décision de l'utilisateur est lue comme annulée.

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
| `src/core/` | Stockage, tokens d'agent, client GitHub, commandes `git`, conteneurs Podman (`containers.ts`), gestionnaires de paquets (`managers/` : repérage des projets, audit, corrections automatiques, lecture des lockfiles, outils de Claude ; un fichier par gestionnaire), rapports `npm audit` et lockfiles, opérations, dépôts ; coffre (`vault.ts`), connexion SSH (`ssh.ts`), serveurs de déploiement (`deploy-servers.ts`) et déploiements (`deployments.ts`) ; configuration du serveur (`server-config.ts`) et authentification (`auth.ts`). |
| `src/package-tools.ts` | Serveur MCP des commandes des gestionnaires de paquets fourni à Claude Code pendant ses corrections. |
| `src/cli/setup-mcp.ts` | Commande `--claude-setup-mcp`. |
| `src/cli/users.ts` | Commandes `user add`, `user password`, `user totp`, `user remove`, `user list`. |
| `shared/schemas/` | Schémas zod communs au serveur et à la GUI. |
| `gui/` | Vite + React 19 + zustand, CSS écrit à la main. |
| `test/` | Tests `node --test`. |

Les tests utilisent une fausse API GitHub (dépôts, alertes paginées, utilisateur, création et liste des pull requests) et des dépôts nus locaux servis par `file://` (`GITHUB_API_URL`, `GITHUB_SERVER_URL`). `test/operations.test.ts` et `test/server.test.ts` lancent un vrai `npm audit` sur un petit projet vulnérable (`test/fixtures/vulnerable` : `lodash`, corrigé par `audit fix`, et `nth-check`, qui demande une montée majeure ; `test/fixtures/vulnerable-dev`, le même avec `nth-check` en devDependency, pour le périmètre production). Leurs manifestes s'appellent `package.fixture.json` et `package-lock.fixture.json`, pour que ni le tracker ni Dependabot ne les auditent dans ce dépôt ; la copie dans les dépôts de test leur rend leur nom. Ces tests ont besoin du registre npm et sont ignorés, avec la raison, s'il est injoignable. Les conteneurs y passent par un faux Podman (`test/fake-podman.ts`), qui note ses appels et lance la commande directement sur la machine, dans le dossier de l'hôte qui correspond au dossier de travail du conteneur : npm doit donc être dans le `PATH` pour les tests. `test/server.test.ts` le trouve dans le `PATH` du serveur, par un script POSIX : ses tests d'opérations sont ignorés sous Windows. `test/podman.test.ts` lance de vrais conteneurs, sous Linux quand Podman est installé : npm dans l'image officielle, lockfile écrit dans le clone sous le compte courant, isolation du conteneur. `test/server.test.ts` crée un compte (`user add`), lance le serveur (`serve`) sur un port libre, ouvre une session, vérifie l'authentification (session exigée, inscription fermée, requêtes d'un autre site, commandes `user`, limitation des connexions), crée un token d'agent par l'API de l'interface, puis lance le mode MCP (`mcp`) sur stdio : il parcourt les outils, les tokens et la correction complète depuis l'API de l'interface. Les corrections par Claude passent par un faux Claude Code (`test/fake-claude.ts`, qui note ses appels, appelle les outils du serveur `npm` du tracker et répond en `stream-json`) et un faux organizer (tâches, assignations, tags). `test/deploy.test.ts` connecte un serveur et déploie sur un faux serveur SSH (`test/fake-ssh.ts`, bâti sur `ssh2`) qui n'accepte que les clés du fichier dédié, en respectant leur option `from`, et exécute réellement les commandes avec bash : `bash` doit être dans le `PATH` (Git Bash sous Windows). `test/two-factor.test.ts` active la double authentification d'un compte (`user totp`) sur son propre serveur et vérifie la connexion en deux étapes, par code TOTP puis par code de secours.

## Publication

Chaque push sur `master`, merge de pull request compris, publie une nouvelle version sur npm (`.github/workflows/publish.yml`), en deux jobs. Le job `build`, en lecture seule sur le dépôt et sans accès à l'OIDC, installe bubblewrap (les tests des corrections par Claude vérifient le bac à sable de Claude Code ; Podman est déjà installé sur le runner, et `test/podman.test.ts` s'en sert), lance `npm ci`, le build (dont `npm ci` dans `gui/`) et les tests, puis transmet le paquet compilé (`dist/`, `gui/dist/`) comme artefact. Le job `publish`, seul à pouvoir écrire sur le dépôt et obtenir un jeton OIDC, récupère cet artefact sans rien installer, lance `npm version patch`, puis `npm publish --ignore-scripts` et enfin le push sur `master` du commit et du tag de version : aucun code des dépendances ne s'exécute là où la publication est possible. Les actions sont épinglées par SHA de commit. La publication passe par le trusted publishing de npm (OIDC, sans token), avec attestation de provenance. Un échec du build ou des tests arrête le workflow avant la montée de version ; un échec de `npm publish` l'arrête avant le push, si bien que relancer le run reprend la même version.

Sur npmjs.com, le paquet déclare ce workflow comme publieur de confiance (Settings → Trusted publishing → GitHub Actions : `Matthieu-Pesnot-Pin`, `mcp-dependabot-tracker`, `publish.yml`, avec `npm publish` dans les actions autorisées). Le commit de version est poussé avec `GITHUB_TOKEN` : si `master` est protégée, la règle doit autoriser GitHub Actions à y pousser.
