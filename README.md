# @imenam/mcp-dependabot-tracker

Suivi des alertes Dependabot de dépôts GitHub, et correction de leurs vulnérabilités npm dans un clone temporaire, depuis une interface graphique ou par un agent.

Pour chaque dépôt suivi, l'interface montre les alertes Dependabot ouvertes et lance une **correction**, menée de bout en bout sans intervention : clone temporaire de la branche choisie pour le dépôt (la branche par défaut tant qu'aucune autre n'est choisie), `npm audit`, `npm audit fix`, corrections par Claude s'il reste des vulnérabilités, puis commit sur une nouvelle branche, push et pull request. L'utilisateur décide, dépôt par dépôt, de ce que l'agent peut faire par les outils MCP : audit, audit fix, push.

```
Utilisateur (GUI) ──ajoute un dépôt, accorde les droits, corrige──▶  Tracker  ──API GitHub──▶ alertes, PR
Agent ──list_repositories / get_alerts / run_audit / fix_vulnerabilities──▶  (dans la limite des droits)
```

L'agent n'exécute jamais `git` ni `npm` lui-même : tout passe par les outils. Quand `npm audit fix` laisse des vulnérabilités, une correction lancée depuis l'interface fait aussitôt **corriger par Claude** (Claude Code, avec un abonnement Claude) : il analyse chaque vulnérabilité dans le code, corrige ce qu'il peut dans un commit séparé, et rend compte de son travail dans une seule tâche d'un [organizer](https://www.npmjs.com/package/@imenam/mcp-organizer) (voir [Les corrections par Claude](#les-corrections-par-claude)).

---

## Installation

```bash
npm install -g @imenam/mcp-dependabot-tracker
```

Ou via `npx`, sans installation. Le serveur communique en JSON-RPC sur stdio : il est lancé par le client MCP, pas à la main. `git` et `npm` (npm 7 ou plus récent) doivent être dans le `PATH` de la machine qui exécute le serveur. Claude Code, utilisé par les corrections par Claude, est une dépendance du package (`@anthropic-ai/claude-code`, Node 22 ou plus récent) : rien d'autre à installer.

### Déclaration dans un projet

```bash
npx -y @imenam/mcp-dependabot-tracker --claude-setup-mcp --proxy_url=http://localhost:3000
# ou, sans proxy :
npx -y @imenam/mcp-dependabot-tracker --claude-setup-mcp --app_port=4700
```

La commande crée (ou complète) le `.mcp.json` du répertoire courant avec une entrée `mcp-dependabot-tracker`. `--force` remplace une entrée existante ; les autres serveurs sont préservés. `--proxy_url` et `--app_port` sont exclusifs. Il reste à renseigner `GITHUB_TOKEN` et `CLONE_DIR`.

```json
{
  "mcpServers": {
    "mcp-dependabot-tracker": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-dependabot-tracker"],
      "env": {
        "GITHUB_TOKEN": "github_pat_…",
        "PROXY_URL": "http://localhost:3000",
        "APP_PORT": "",
        "APP_GROUP": "",
        "APP_NAME": "Dependabot Tracker",
        "APP_PATH": "/dependabot-tracker",
        "CLONE_DIR": "D:/clones/dependabot-tracker",
        "MCP_DATA_DIR": "",
        "MCP_LOG_DIR": ""
      }
    }
  }
}
```

Les dépôts suivis ne dépendent d'aucun projet : toutes les instances partagent par défaut le même répertoire de données, `~/.mcp-dependabot-tracker`.

### Token GitHub

Un token à grain fin, limité aux dépôts suivis, avec les permissions :

| Permission | Accès | Pour |
|---|---|---|
| Dependabot alerts | lecture | lire les alertes |
| Contents | lecture et écriture | cloner, pousser la branche de correction |
| Pull requests | lecture et écriture | ouvrir la pull request, suivre celles qui attendent d'être mergées |
| Metadata | lecture | imposée par GitHub ; liste les dépôts proposés à l'ajout |

Un token classique convient aussi, avec les scopes `repo` et `security_events`. Les commits sont signés du compte du token, avec son adresse `noreply` GitHub. Le token est transmis à `git` par un en-tête HTTP (`http.<serveur>/.extraheader`, dans l'environnement de la commande) : il n'est écrit ni dans le clone ni dans la ligne de commande. Les commandes `git` et `npm` ne reçoivent pas `GITHUB_TOKEN` dans leur environnement.

### Variables d'environnement

Elles se renseignent dans le champ `env` de la déclaration, ou dans un fichier `.env` à la racine du package, qui prime et est relu à chaque relance de la GUI.

| Variable | Rôle |
|---|---|
| `GITHUB_TOKEN` | Token GitHub (voir ci-dessus). Sans lui, les outils et l'interface signalent qu'il manque ; aucune alerte n'est lue. |
| `GITHUB_API_URL` | API GitHub (défaut `https://api.github.com`), à changer pour GitHub Enterprise Server. |
| `GITHUB_SERVER_URL` | Serveur git des clones (défaut `https://github.com`) : un dépôt se clone depuis `<serveur>/<propriétaire>/<nom>.git`. |
| `PROXY_URL` | URL du [proxy central](https://github.com/imenam/proxy-setup) : le proxy attribue le port et monte la GUI sous `APP_PATH`. Prime sur `APP_PORT`. |
| `APP_PORT` | Port local utilisé quand `PROXY_URL` est absent : la GUI est servie sur `http://localhost:<port>`. |
| `APP_PATH` | Chemin de montage derrière le proxy (défaut `/dependabot-tracker`). |
| `APP_PATH_PREFIX` | Préfixe de namespace appliqué au chemin par le client proxy partagé ; le `<base href>` de la GUI suit le chemin réellement enregistré. |
| `APP_NAME` | Nom affiché dans le dashboard du proxy (défaut `Dependabot Tracker`). |
| `APP_GROUP` | Section repliable du dashboard du proxy (facultatif). |
| `CLONE_DIR` | **Obligatoire.** Dossier où chaque opération crée son clone ; il est créé s'il n'existe pas. Sans cette variable, le serveur refuse de démarrer. |
| `MCP_DATA_DIR` | Répertoire des données (défaut `~/.mcp-dependabot-tracker`). |
| `MCP_LOG_DIR` | Répertoire des logs. Défaut : `<données>/logs`. |

Sans `PROXY_URL` ni `APP_PORT`, la GUI est désactivée ; les outils MCP fonctionnent.

### Dans mcp-http-gateway et le gateway manager

Le serveur ne lit rien sur la machine de l'agent : clones, `npm` et appels à GitHub ont lieu sur la machine qui l'exécute. Dans un gateway ([mcp-http-gateway](https://www.npmjs.com/package/@imenam/mcp-http-gateway)), il se déclare comme tout autre MCP, dans `config/mcp-servers.json` :

```json
{
  "mcpServers": {
    "dependabot-tracker": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-dependabot-tracker"],
      "env": {
        "MCP_SERVER_ROUTE": "/dependabot-tracker",
        "GITHUB_TOKEN": "github_pat_…",
        "CLONE_DIR": "/var/lib/dependabot-tracker/clones"
      }
    }
  }
}
```

- Aucune route d'exécution (`GATEWAY_EXEC_ROUTES`) n'est nécessaire côté agent.
- Piloté par le gateway manager, la GUI s'enregistre auprès du proxy du hub (`PROXY_URL` et `APP_PATH_PREFIX` sont fournis par le hub) et s'ouvre par le bouton « interface » du MCP.
- `git` et `npm` doivent être installés sur la machine du gateway, qui doit joindre GitHub et le registre npm.

---

## Les outils

Cinq outils, en anglais. Le résultat d'une opération se termine par le lien vers son écran dans la GUI quand celle-ci est active.

| Outil | Droit | Effet |
|---|---|---|
| `list_repositories` | — | Dépôts suivis non dépréciés, tous ou ceux d'une catégorie (`category`, son nom) : catégorie, alertes Dependabot ouvertes par gravité (hors celles que l'utilisateur a corrigées à la main, comptées à part), paquets sans version corrigée au dernier audit, dernier audit sans vulnérabilité qui contredit les alertes, vulnérabilités trouvées par le dernier audit de la branche par défaut quand Dependabot ne signale rien, date de la dernière lecture (et son erreur), droits de l'agent, pull requests du tracker pas encore mergées, opération en cours. |
| `get_alerts` | — | Relit sur GitHub les alertes ouvertes d'un dépôt (`repository`) et les liste de la plus grave à la moins grave : numéro, gravité, paquet, écosystème, manifeste, portée de la dépendance (exécution ou développement), résumé, version corrigée, marque « corrigée à la main » de l'utilisateur, lien. |
| `run_audit` | audit | `npm audit` dans un clone temporaire, sur le périmètre `scope` (`production` par défaut, ou `all`) : vulnérabilités par projet npm, avec la correction proposée (aucune, dans les plages déclarées, ou montée majeure). Rien n'est modifié. |
| `fix_vulnerabilities` | fix (+ push) | Clone, `npm audit`, `npm audit fix`, sur le périmètre `scope` (`production` par défaut, ou `all`), sans corrections par Claude ; avec `push: true`, commit (`commit_message`, défaut `fix(deps): resolve npm audit vulnerabilities`), push d'une nouvelle branche et pull request vers la branche analysée. Sans `push`, rien ne sort du clone : le résultat décrit ce que les corrections changent. |
| `reconnect_gui` | — | Relance le worker GUI et le réenregistre auprès du proxy. |

Un outil refuse une action dont l'agent n'a pas le droit, en le disant ; seul l'utilisateur change les droits, dans la GUI. L'agent ne peut ni ajouter ni retirer de dépôt. Un dépôt déprécié est refusé par tous les outils, jusqu'à ce que l'utilisateur le rétablisse. Un champ inconnu fait échouer l'appel. Les outils d'opération attendent la fin de l'opération.

---

## Une opération

Chaque opération travaille dans un clone temporaire (`<CLONE_DIR>/mcp-dependabot-tracker-*/repo`, `git clone --depth 1` de la branche analysée), supprimé dès qu'elle se termine, réussie, échouée ou annulée.

La **branche analysée** se choisit par dépôt dans la GUI ; c'est la branche par défaut tant qu'aucune autre n'est choisie. L'agent l'utilise aussi, sans pouvoir en changer. Les alertes Dependabot, elles, portent toujours sur la branche par défaut, la seule que GitHub analyse : sur une autre branche, c'est `npm audit` qui mesure les vulnérabilités.

Le **périmètre** se choisit à chaque lancement d'une correction, d'un audit ou de « Auditer tout » : **production** (par défaut) ajoute `--omit=dev` à `npm audit` et `npm audit fix`, qui laissent alors les devDependencies de côté ; **toutes les dépendances** les couvre aussi. Chaque alerte Dependabot porte la portée de sa dépendance (`dependency.scope` de l'API GitHub : exécution ou développement). Un audit de production ne se compare qu'aux alertes qui ne portent pas sur une dépendance de développement ; une alerte de portée inconnue compte comme une alerte de production. Une opération enregistrée avant ce choix est lue comme un audit de toutes les dépendances.

1. **Cloner le dépôt** — puis repérer les projets npm : chaque dossier dont le `package-lock.json` est suivi par git (racine, `gui/`…). Un dépôt sans lockfile fait échouer l'opération : `npm audit` en a besoin. Un lockfile v1 (npm 6) est refusé.
2. **npm audit** — `npm audit --json` dans chaque projet, avec `--omit=dev` en production.
3. **npm audit fix** — `npm audit fix --package-lock-only --ignore-scripts` dans chaque projet vulnérable : seuls les lockfiles changent, sans installation de `node_modules` ni script de paquet. Puis un nouvel audit. Les commandes npm du tracker reçoivent `npm_config_allow_remote=all` : avec `--package-lock-only`, npm 12 refuse sinon les archives des paquets à `bundleDependencies` comme `@tailwindcss/oxide-wasm32-wasi` ([npm/cli#9800](https://github.com/npm/cli/issues/9800)). Ce réglage ne vaut que pour ces commandes, pas pour la configuration npm de la machine.
4. **Corrections par Claude** — pour une correction lancée depuis la GUI, dès que des vulnérabilités restent : la branche `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>` (heure locale du serveur) est créée, les lockfiles de `npm audit fix` y sont commités, puis Claude analyse et corrige en une session (voir [Les corrections par Claude](#les-corrections-par-claude)). Passées quand rien ne reste, et toujours pour une opération de l'agent. Un échec, Claude non configuré compris, laisse la correction se poursuivre avec les seules corrections de `npm audit fix`.
5. **Commit et push** — commit des fichiers modifiés sur la branche `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>`, push, puis pull request vers la branche analysée, titrée du message de commit par défaut. Après les corrections par Claude, la branche porte déjà ses commits : seuls le push et la pull request restent à faire. Le corps de la pull request donne le périmètre et la commande exacte, les vulnérabilités avant et après, les paquets mis à jour et, le cas échéant, le résumé des corrections par Claude, fichier par fichier, avec le résultat des tests et la clé de sa tâche. Un avertissement en tête signale l'échec de Claude (la pull request ne porte alors que les corrections de `npm audit fix`) ou des tests en échec après ses corrections.

**Pull requests en attente** — à chaque lecture d'un dépôt (toutes les 10 minutes, ou « Synchroniser maintenant »), le tracker lit ses pull requests ouvertes sur GitHub et garde celles dont la branche suit le nommage `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>` et appartient au dépôt lui-même (pas à une fourche). Les pull requests ouvertes avant cette fonction sont donc reconnues, même quand l'historique des opérations ne les contient plus. Une pull request mergée ou fermée disparaît à la lecture suivante, ou aussitôt quand l'utilisateur la marque mergée dans l'onglet « PR en attente » ; une pull request que le tracker vient d'ouvrir apparaît aussitôt.

**Auditer tout** — depuis l'accueil, un audit seul (clone et `npm audit`, sans correction) de la **branche par défaut** de chaque dépôt suivi de l'onglet affiché : tous les dépôts sur « Tous mes projets » et « Dépréciés », ceux de la catégorie quand une catégorie est affichée (le bouton s'intitule alors « Auditer la catégorie »), ceux de la file d'attente sur son onglet (« Auditer la file »), quelle que soit sa branche analysée : c'est la branche que Dependabot analyse, et la seule sur laquelle les deux se comparent. Trois audits tournent à la fois. Un dépôt où une opération est déjà en cours est laissé de côté ; un audit qui échoue (dépôt sans `package-lock.json`, clone impossible) n'arrête pas les autres. La série vit dans le processus qui sert la GUI ; une seule à la fois.

Les paquets mis à jour sont lus en comparant chaque lockfile à celui du commit cloné : version changée, paquet ajouté ou retiré. S'il n'y a rien à corriger, ou si les corrections ne changent rien, l'opération se termine sans push.

Depuis la GUI comme pour l'agent, une opération va d'un bout à l'autre sans attendre de décision ; l'agent choisit seulement de pousser ou non (`push`). Une seule opération à la fois par dépôt.

**Annulation** — une opération en cours reçoit une demande d'annulation que le processus qui l'exécute lit toutes les 500 ms : il arrête la commande en cours (arbre de processus compris, Claude Code compris) et supprime le clone ; rien n'est poussé. Une opération dont le processus a disparu passe en échec à la lecture suivante.

---

## Les corrections par Claude

Quand `npm audit fix` laisse des vulnérabilités dans une correction lancée depuis la GUI, le tracker enchaîne sans attendre :

1. il crée la branche `fix/npm-audit-…` et y commite les lockfiles modifiés par `npm audit fix` (premier commit, avec le message par défaut), s'ils ont changé ;
2. il lance une session Claude Code non interactive (`claude -p`) dans le clone, avec les vulnérabilités restantes (extraites de `npm audit --json`). Claude analyse chaque vulnérabilité dans le code (usage du paquet, faille atteignable ou non, urgence), monte ou épingle les dépendances (`package.json`, entrées `overrides`, puis mise à jour du lockfile), adapte le code, relance `npm audit`, installe les dépendances (`npm ci`) et lance les tests, par les outils npm du tracker ;
3. Claude crée **une seule tâche** « Rapport de correction — … » dans l'espace organizer réglé, assignée au propriétaire de l'espace et taguée du nom du dépôt : son unique rapport, en français, avec l'analyse de chaque paquet vulnérable, chaque changement fichier par fichier et sa raison, le résultat de l'audit et des tests (un avertissement en tête quand ils échouent), et ce qui reste à corriger ou à vérifier à la main. Il rend un rapport structuré (`--json-schema`) : clé de la tâche, résumé, fichiers modifiés, message de commit, résultat des tests ;
4. le tracker vérifie la tâche (assignée, taguée), commite les changements de Claude (second commit, au message proposé par Claude, avec `Co-Authored-By: Claude`), sans les `node_modules`, relance `npm audit`, puis pousse la branche et ouvre la pull request.

Une tâche introuvable, sans le tag ou non assignée au propriétaire fait échouer la session, comme une erreur de Claude, un dépassement des limites, l'organizer ou le token Claude non réglés, ou un bac à sable impossible : le clone revient au commit de `npm audit fix`, l'erreur s'affiche sous l'étape, et la correction pousse quand même les corrections de `npm audit fix`, avec un avertissement en tête de la pull request. L'annulation de l'opération arrête Claude Code.

**Ce que Claude peut faire** — outils intégrés `Read`, `Grep`, `Glob`, `Edit` et `Write`, sans shell : ni `git`, ni push. `Edit` et `Write` refusent tout chemin hors du clone (`blockWritesOutsideWorkingDirectories`). Claude lance npm par les outils d'un second serveur MCP, `npm`, que le tracker lui fournit (`dist/src/npm-tools.js`) : `npm_install_lockfile` (`npm install --package-lock-only --ignore-scripts`, avec les paquets à ajouter ou monter), `npm_audit` (avec le périmètre de l'opération), `npm_ci`, `npm_test`, `npm_run` (un script de `package.json`), `npm_ls` et `tsc` (`npm exec --no -- tsc --noEmit`). Chaque outil lance une commande fixe dans un dossier du clone qui contient un `package.json` ; ses arguments ne sont que des noms de paquets ou de scripts. Le bac à sable de Claude Code garde en lecture seule les manifestes, les lockfiles et `node_modules` : ces commandes tournent donc hors de lui, dans un bac à sable **bubblewrap** du tracker. Seuls le système (`/usr`, `/etc`, Node.js…) y est visible, en lecture seule ; le clone et le cache npm de l'opération y sont en écriture, `/tmp` est vide, et l'environnement se réduit à `PATH`, `LANG`, `HOME`, au cache npm et à `CI=true` : ni les données du tracker, ni les autres clones, ni aucun token. Le réseau reste ouvert pour `npm ci`. Hors de Linux, ces commandes tournent directement dans le clone. Claude Code ne reçoit jamais `GITHUB_TOKEN`, et `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` retire son propre token de l'environnement des processus qu'il lance ; sous Linux, Claude Code exige alors lui aussi bubblewrap. Installez-le sur le serveur (`sudo apt-get install -y bubblewrap socat`). Avant chaque lancement, le tracker crée un bac à sable d'essai avec le compte et les restrictions du serveur ; s'il échoue, le lancement est refusé avec la raison : `bwrap` absent, restriction AppArmor des espaces de noms utilisateur (`kernel.apparmor_restrict_unprivileged_userns`, Ubuntu 24.04 et suivantes) ou durcissement du service (`RestrictNamespaces`, `PrivateUsers`, `SystemCallFilter`). Côté organizer, seuls `create_task`, `set_assignees`, `set_tags` et `get_task` sont autorisés ; tout autre appel est refusé (`--permission-mode dontAsk`), et les réglages Claude du dépôt cloné ne sont pas lus (`--setting-sources user`). Installer les dépendances et lancer les tests exécute le code du projet et de ses paquets dans le clone, à chaque correction lancée depuis la GUI qui laisse des vulnérabilités. La configuration MCP, qui porte le token de l'organizer, est écrite hors du clone et supprimée en fin de session.

**Limites** — nombre de tours (`--max-turns`, défaut 40) et durée (défaut 15 min, au-delà de laquelle le tracker arrête Claude Code), réglables dans la GUI.

**Réglages** (écran Réglages, roue dentée de l'accueil) :

- **Organizer** — adresse du site (https, sauf pour un site de cette machine) et token d'agent, créé dans l'organizer (Paramètres › Agents) : il couvre un espace, avec les droits de son créateur. Une connexion modifiée est testée à l'enregistrement ; « Tester » la reteste. L'écran affiche l'espace et son propriétaire.
- **Claude** — un token d'abonnement (Pro, Max, Team ou Enterprise) : lancer `claude setup-token` sur un poste avec navigateur, autoriser l'accès, puis coller le token affiché (valable un an). Il est vérifié à l'enregistrement par une requête minimale ; un token refusé n'est pas enregistré. L'écran affiche sa date d'enregistrement et d'expiration.
- **Corrections par Claude** — les limites d'une session.

Les tokens sont enregistrés dans `<données>/settings.json`, lisible par le seul compte du serveur ; la GUI n'en reçoit que les quatre derniers caractères. Claude Code garde sa configuration dans `<données>/claude`. Derrière le gateway manager, l'écran est protégé comme le reste de l'interface, par la session du hub.

**Suivi** — la tâche du dernier rapport de Claude s'affiche dans la colonne « Suivi » de la ligne du dépôt (« MNT-12 », qui ouvre la tâche sur l'organizer) tant qu'elle n'est pas terminée : son statut est relu sur l'organizer avec les alertes, toutes les 10 minutes. La pull request de la correction mentionne la clé de la tâche.

---

## L'interface

Thème sombre, une information par ligne, une action principale par écran.

- **Accueil (`#/`, `#/c/<catégorie>`)** — à gauche, la barre des catégories : « Tous mes projets », « File d'attente » avec le nombre de dépôts qu'elle contient, « PR en attente » avec le nombre de dépôts dont une pull request du tracker attend, « À déployer » avec le nombre de dépôts marqués, puis chaque catégorie, chacune avec le nombre d'alertes ouvertes de ses dépôts, coloré selon la plus grave (aucune pastille sans alerte), précédé du nombre de pull requests du tracker en attente (aucune pastille sans pull request). « Nouvelle catégorie » ouvre un champ en place (Entrée crée, Échap annule) ; au survol d'une catégorie, « … » propose de la renommer ou de la supprimer (un second clic confirme ; ses dépôts restent suivis, sans catégorie). Un dépôt appartient à une catégorie au plus. En bas de la barre, « Dépréciés » ouvre l'onglet des dépôts dépréciés, avec leur nombre.
  À droite, les dépôts non dépréciés de la catégorie choisie, du plus exposé au moins exposé (gravité la plus haute, puis nombre de vulnérabilités). L'interrupteur « Vulnérables seulement » ne garde que les dépôts réellement vulnérables : des paquets sans version corrigée au dernier audit, des alertes non corrigées à la main que le dernier audit ne contredit pas, ou des vulnérabilités trouvées par l'audit alors que Dependabot ne signale rien ; le navigateur retient sa position. Les dépôts forment un tableau à en-tête, une ligne par dépôt : le nom (`propriétaire/dépôt` en infobulle), trois colonnes de largeur fixe, « Sécurité », « Dernier audit » et « Suivi », puis les boutons et le chevron. Un contenu trop long est coupé, jamais poussé sur la colonne voisine, et l'infobulle le donne en entier.
  **Sécurité** — la pastille des alertes Dependabot non corrigées à la main, colorée selon la plus grave. Elle est estompée quand le dernier audit de la branche par défaut, plus récent que chacune d'elles, n'a trouvé aucune vulnérabilité : Dependabot n'a pas encore repassé. Elle est suivie de « dév. » quand toutes portent sur des dépendances de développement et que le dernier audit de production de la branche par défaut n'a rien trouvé. Des alertes toutes marquées corrigées à la main gardent une pastille estompée et ne comptent plus, ni ici, ni dans la barre des catégories. Sans alerte Dependabot, une pastille « N vulnérabilités » reprend ce qu'a trouvé le dernier audit de la branche par défaut, que Dependabot n'a pas encore vu ; ces vulnérabilités comptent dans la barre des catégories comme les alertes. « à la main » (icône de clé) signale les paquets pour lesquels le dernier audit n'a trouvé aucune version corrigée publiée, listés en infobulle. Sinon, la cellule affiche « Synchronisation impossible » (l'erreur en infobulle), « Synchronisation… » avant la première lecture, ou « — ».
  **Dernier audit** — l'opération en cours (« Audit en cours », « Correction en cours », « Corrections par Claude… »), sinon le résultat du dernier audit, quelle que soit sa branche, et sa date : « OK », « Prod. OK » pour un audit des seules dépendances de production, ou « N vulnérabilités » ; le périmètre et la branche sont en infobulle. « — » sans audit.
  **Suivi** — des marqueurs discrets, chacun avec son infobulle : la pull request du tracker en attente (« #42 », ou « 2 PR », qui ouvre la liste des pull requests du dépôt), la tâche organizer du dernier rapport de Claude tant qu'elle n'est pas terminée (« MNT-12 », qui ouvre la tâche), la file d'attente et la marque « à déployer », leur date en infobulle.
  Les boutons de la ligne n'apparaissent qu'au survol, et en permanence sur un écran tactile. Le dernier, avant le chevron (icône archive), marque le dépôt **déprécié** (refusé pendant une opération). Un dépôt déprécié n'est plus synchronisé ni audité (ni par la relecture des 10 minutes, ni par « Synchroniser maintenant » et « Auditer tout », ni par l'agent), ne compte dans aucune pastille et quitte sa catégorie à l'affichage tout en la gardant. Le marquer déprécié le retire aussi de la file d'attente et lui retire la marque « à déployer ».
  Juste avant, un bouton (icône de fusée) marque le dépôt **à déployer**, pour un dépôt sans déploiement automatique dont la correction reste à déployer : il reste allumé tant que le dépôt est marqué, et un nouveau clic retire la marque.
  Avant ces boutons, un autre (icône de liste) met le dépôt dans la **file d'attente** ; il reste allumé tant que le dépôt y est, et un nouveau clic l'en retire. Dans une catégorie, « Tout ajouter à la file », à côté de l'interrupteur, y met d'un coup tous ses dépôts qui n'y sont pas encore (inactif quand ils y sont tous).
  « Ajouter un dépôt » ouvre une fenêtre avec un champ de recherche et la catégorie. Dès la première lettre, jusqu'à dix dépôts accessibles au token et pas encore suivis sont proposés (ceux dont le nom commence par la saisie d'abord) ; ↑ et ↓ parcourent, Entrée ou un clic reportent le dépôt dans le champ, Échap referme la liste, puis la fenêtre. La catégorie part de celle affichée. « Ajouter » valide ; sans suggestion, Entrée aussi. La saisie peut être `propriétaire/dépôt` ou un lien GitHub. Un nouveau dépôt n'accorde que l'audit à l'agent.
  Dans la colonne « Suivi », « #42 » ouvre la pull request sur GitHub, « 3 PR » la liste des pull requests du dépôt.
  « Synchroniser maintenant », à côté, relit tout de suite les alertes et les pull requests de tous les dépôts, sans attendre la relecture des 10 minutes ; l'icône tourne jusqu'à la fin. « Auditer tout » audite la branche par défaut de tous les dépôts (voir plus haut) : un clic l'audite en production, la flèche à côté propose « Production » ou « Toutes les dépendances » ; le bouton affiche la progression (« Audit 4/12… »), chaque dépôt audité affiche « Audit en cours », et un message final donne le nombre de dépôts audités, laissés de côté et en échec (avec leurs noms).
  La roue dentée, à gauche de « Synchroniser maintenant », ouvre les réglages.
- **File d'attente (`#/queue`)** — les dépôts mis en file, non dépréciés, dans l'ordre de leur entrée dans la file, avec les mêmes informations et le même interrupteur que l'accueil. Le chevron ouvre le dépôt pour l'auditer ou le corriger. « Traité », sur chaque ligne, retire le dépôt de la file sans toucher à sa catégorie.
- **PR en attente (`#/pulls`)** — les dépôts non dépréciés dont une pull request du tracker attend d'être mergée, de la plus ancienne à la plus récente, avec l'interrupteur de l'accueil. Une correction aboutie y place son dépôt dès l'ouverture de sa pull request. Sur chaque ligne, « Mergée » retire aussitôt le dépôt de l'onglet, pour un dépôt au déploiement automatique ; « Mergée, à déployer » le fait passer en plus dans « À déployer ». La relecture des 10 minutes retire aussi les pull requests mergées ou fermées sur GitHub ; une pull request marquée mergée mais encore ouverte sur GitHub y revient à la lecture suivante.
- **À déployer (`#/deploy`)** — les dépôts marqués « à déployer », non dépréciés, dans l'ordre où ils ont été marqués, avec les colonnes de l'accueil (la date de la marque en infobulle de la fusée) et son interrupteur. Le chevron ouvre le dépôt. « Déployé », sur chaque ligne, retire la marque sans toucher à sa catégorie ni à la file d'attente.
- **Réglages (`#/settings`)** — connexion à l'organizer, token Claude et limites des corrections par Claude (voir [Les corrections par Claude](#les-corrections-par-claude)). Un token enregistré n'apparaît que par ses quatre derniers caractères, avec « Remplacer ». « Enregistrer » valide tout l'écran.
- **Dépréciés (`#/deprecated`)** — les dépôts dépréciés, du plus récent au plus ancien, avec la date de dépréciation. « Rétablir », sur chaque ligne, remet le dépôt dans sa catégorie et relit aussitôt ses alertes. Le chevron ouvre l'écran du dépôt, où « Corriger » est désactivé.
- **Dépôt (`#/r/<propriétaire>/<nom>`, `#/r/<propriétaire>/<nom>/history`)** — sélecteur de la branche analysée (un clic ouvre la liste des branches avec un champ de recherche, la branche par défaut en tête ; ↑ ↓ et Entrée ou un clic choisissent, Échap ferme), sélecteur de la catégorie (« Sans catégorie » ou l'une des catégories) et date de la dernière lecture des alertes, puis deux onglets. **Alertes ouvertes**, avec leur nombre : les alertes ouvertes (gravité, paquet, résumé), chacune ouvrant l'alerte sur GitHub. Une alerte dont le paquet n'a aucune version corrigée publiée porte « ⚠ sans correctif », une alerte sur une dépendance de développement l'étiquette « dév. ». Au survol d'une alerte, « Corrigée à la main » la range dans la section « Corrigées à la main », avec la date du marquage ; « Rétablir » la remet à traiter. Dependabot continue souvent de signaler une alerte corrigée à la main (un paquet installé hors du registre npm, par exemple) : la marque tient tant que l'alerte reste ouverte, et tombe à la lecture suivante si Dependabot émet une nouvelle alerte sur le même paquet. **Historique**, avec le nombre d'opérations : une ligne par opération conservée (les 20 dernières du dépôt), de la plus récente à la plus ancienne, avec audit ou correction, qui l'a lancée, le périmètre, la branche, la date, les vulnérabilités avant et après (le début de l'erreur pour une opération échouée), la part de Claude (« Claude » quand il a été lancé) et l'issue (la pull request, « terminée », « annulée », « échouée ») ; chaque ligne ouvre l'opération. « Corriger » lance une correction en production ; la flèche à côté ouvre le choix du périmètre (« Production » ou « Toutes les dépendances », Échap ferme). « Voir la correction en cours » rouvre celle en cours. À gauche d'« Agent », « Traité » retire de la file d'attente un dépôt qui y est et ramène à la file ; pour un dépôt hors de la file, « Ajouter à la file » l'y met (absent pour un dépôt déprécié). Juste avant, « À déployer » marque le dépôt ; une fois marqué, le bouton s'allume et devient « Déployé », qui retire la marque (absent pour un dépôt déprécié). « Agent » ouvre le volet des droits : trois interrupteurs (audit, audit fix, push), enregistrés aussitôt, et « Retirer le dépôt » (un second clic confirme dans les 4 secondes ; refusé pendant une opération).
- **Correction (`#/r/<propriétaire>/<nom>/op/<id>`)** — qui l'a lancée (vous ou l'agent), la branche clonée, le périmètre ; les flèches « 1 / 5 » passent à l'opération plus récente ou plus ancienne du dépôt, la flèche de retour ramène à son historique. Trois onglets : **Étapes**, **Claude** (quand Claude est intervenu) et **Journal**. Les étapes se suivent sans décision à prendre : chacune tient sur une ligne avec son résultat (« 4 vulnérabilités », « 3 corrigées », lien vers la pull request). Une étape passée en donne la raison : « rien à corriger » quand `npm audit fix` a tout corrigé, « rien à pousser » quand les corrections n'ont rien changé, « ignorée » sinon. Les vulnérabilités sans aucune version corrigée publiée sur le registre npm (`fixAvailable: false`, par exemple `xlsx`, que SheetJS ne publie plus sur npm) sont comptées sur la ligne du dernier audit (« 1 sans correctif ») ; un clic les liste avec leur gravité : leur mise à jour est à faire à la main. Pendant les corrections par Claude, l'étape montre leur durée, leurs tours et les trois dernières actions de Claude ; ensuite, ce qu'il a changé : résumé, fichiers, tests, vulnérabilités restantes et lien vers sa tâche de rapport. Un échec de Claude s'affiche sous l'étape (« échouées · corrections de npm audit fix seules »). Une fois la pull request ouverte, l'étape du push montre la branche et « voir les changements » (paquets mis à jour, replié) ; tant que la pull request attend, elle propose aussi « Mergée » et « Mergée, à déployer », comme l'onglet « PR en attente ». Une erreur s'affiche sous l'étape qui a échoué. L'onglet « Claude » montre la session : sa tâche de rapport, le déroulé complet de ses messages et de ses actions (500 derniers) et son résultat : le résumé des corrections, les fichiers modifiés, le commit, les tests et les vulnérabilités restantes, ou la raison de l'échec. L'onglet « Journal » montre les commandes lancées et leurs résultats ; « Annuler » arrête l'opération.

Les écrans se relisent par polling : toutes les 3 s pour les listes, toutes les secondes pendant une opération. Un écran rouvert affiche aussitôt la dernière réponse reçue, puis se met à jour ; seuls les réglages attendent une lecture fraîche.

---

## Architecture

Deux processus, selon le standard de l'écosystème (`@imenam/mcp-gui-interface`) :

- **Maître MCP** (`src/index.ts`) — JSON-RPC sur stdio, outils (`src/tools/`), logique (`src/core/`), relecture des alertes et des pull requests toutes les 10 minutes, cycle de vie du worker via `GuiLauncher`.
- **Worker GUI** (`src/gui-worker.ts`) — Hono, enregistrement auprès du proxy ou écoute sur `APP_PORT`, API REST transmise au maître par IPC, fichiers de la SPA avec la balise `<base>` du chemin de montage. Il écoute sur `127.0.0.1` derrière `honoGuiGuard`.

| Route | Effet |
|---|---|
| `GET /api/config` | Version, répertoire des données, présence du token. |
| `GET /api/repos`, `POST /api/repos` | Dépôts suivis, dépréciés compris (avec catégorie, opération en cours et dernière opération) et catégories ; ajout d'un dépôt (`{ repository, categoryId? }`). |
| `POST /api/sync` | Relit tout de suite les alertes et les pull requests de chaque dépôt suivi non déprécié, en parallèle ; renvoie les dépôts et les catégories. |
| `GET /api/audit-all`, `POST /api/audit-all` | État de la dernière série « Auditer tout » (`null` si aucune depuis le démarrage) : en cours ou non, dépôts traités sur le total, laissés de côté, en échec avec la raison ; lancement d'une série sur le périmètre `scope` du corps (`production` ou `all`) et les dépôts de `target` : `{ "kind": "all" }`, `{ "kind": "category", "categoryId": … }` ou `{ "kind": "queue" }` (`404` si la catégorie n'existe pas, `409` si une série est en cours). |
| `GET /api/github/repos` | Dépôts accessibles au token (`/user/repos`) et pas encore suivis, pour les suggestions d'ajout. |
| `GET` / `DELETE /api/repos/:propriétaire/:nom` | Dépôt ; retrait. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/deprecated` | Marque le dépôt déprécié (`409` pendant une opération) et lui retire la file d'attente et la marque « à déployer » ; le rétablit et relit ses alertes. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/queued` | Met le dépôt dans la file d'attente (`409` pour un dépôt déprécié ; sans effet s'il y est déjà) ; l'en retire. |
| `PUT` / `DELETE /api/repos/:propriétaire/:nom/deploy-pending` | Marque le dépôt « à déployer » (`409` pour un dépôt déprécié ; sans effet s'il l'est déjà) ; retire la marque. |
| `PUT /api/repos/:propriétaire/:nom/merged` | Retire les pull requests en attente du dépôt, que l'utilisateur dit mergées (`{ deploy }` : avec `true`, le dépôt passe aussi « à déployer » ; `409` pour un dépôt déprécié). |
| `PUT /api/repos/:propriétaire/:nom/rights` | Droits de l'agent. |
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

Erreurs : `400` requête invalide, `404` introuvable, `409` conflit (opération déjà en cours ou déjà terminée, dépôt déprécié), `500` sinon.

### Persistance

`<données>/repos.json` pour les catégories et les dépôts (catégorie, droits, alertes, alertes corrigées à la main, dernière lecture, date de dépréciation), `<données>/operations/<id>.json` pour chaque opération (session de Claude comprise) ; les 20 plus récentes sont conservées par dépôt. `<données>/settings.json` porte les réglages des corrections par Claude et leurs tokens, `<données>/claude` la configuration de Claude Code. Plusieurs instances du serveur (une par session d'agent) partagent le répertoire : les écritures sont atomiques et passent par le verrou `<données>/data.lock`. Une opération lancée par une instance se suit et s'annule depuis la GUI d'une autre. Une opération enregistrée par une version qui attendait une décision de l'utilisateur est lue comme annulée.

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
| `src/index.ts` | Maître MCP : outils, `instructions`, IPC, synchronisation, lancement de la GUI. |
| `src/gui-worker.ts` | Worker GUI : Hono, REST, fichiers statiques, proxy. |
| `src/core/` | Stockage, client GitHub, commandes `git`/`npm`, rapports `npm audit` et lockfiles, opérations, dépôts. |
| `src/tools/` | Outils MCP et mise en forme de leurs résultats. |
| `src/cli/setup-mcp.ts` | Commande `--claude-setup-mcp`. |
| `shared/schemas/` | Schémas zod communs au serveur et à la GUI. |
| `gui/` | Vite + React 19 + zustand, CSS écrit à la main. |
| `test/` | Tests `node --test`. |

Les tests utilisent une fausse API GitHub (dépôts, alertes paginées, utilisateur, création et liste des pull requests) et des dépôts nus locaux servis par `file://` (`GITHUB_API_URL`, `GITHUB_SERVER_URL`). `test/operations.test.ts` et `test/server.test.ts` lancent un vrai `npm audit` sur un petit projet vulnérable (`test/fixtures/vulnerable` : `lodash`, corrigé par `audit fix`, et `nth-check`, qui demande une montée majeure ; `test/fixtures/vulnerable-dev`, le même avec `nth-check` en devDependency, pour le périmètre production) : ils ont besoin du registre npm et sont ignorés, avec la raison, s'il est injoignable. `test/server.test.ts` lance le serveur sur stdio avec sa GUI sur un port libre et parcourt les outils, les droits et la correction complète depuis l'API de la GUI. Les corrections par Claude passent par un faux Claude Code (`test/fake-claude.ts`, qui note ses appels, appelle les outils du serveur `npm` du tracker et répond en `stream-json`) et un faux organizer (tâches, assignations, tags).

## Publication

Chaque push sur `master`, merge de pull request compris, publie une nouvelle version sur npm (`.github/workflows/publish.yml`) : installation de bubblewrap (les tests des corrections par Claude passent par le bac à sable des commandes npm), `npm ci`, build, tests, puis `npm version patch`, `npm publish`, et enfin le push sur `master` du commit et du tag de version. La publication passe par le trusted publishing de npm (OIDC, sans token), avec attestation de provenance. Un échec du build ou des tests arrête le workflow avant la montée de version ; un échec de `npm publish` l'arrête avant le push, si bien que relancer le run reprend la même version.

Sur npmjs.com, le paquet déclare ce workflow comme publieur de confiance (Settings → Trusted publishing → GitHub Actions : `Matthieu-Pesnot-Pin`, `mcp-dependabot-tracker`, `publish.yml`, avec `npm publish` dans les actions autorisées). Le commit de version est poussé avec `GITHUB_TOKEN` : si `master` est protégée, la règle doit autoriser GitHub Actions à y pousser.
