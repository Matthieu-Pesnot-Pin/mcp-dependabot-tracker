# @imenam/mcp-dependabot-tracker

Suivi des alertes Dependabot de dépôts GitHub, et correction de leurs vulnérabilités npm dans un clone temporaire, depuis une interface graphique ou par un agent.

Pour chaque dépôt suivi, l'interface montre les alertes Dependabot ouvertes et lance une **correction** : clone temporaire de la branche choisie pour le dépôt (la branche par défaut tant qu'aucune autre n'est choisie), `npm audit`, `npm audit fix`, `npm audit fix --force` sur décision, puis commit sur une nouvelle branche, push et pull request. L'utilisateur décide, dépôt par dépôt, de ce que l'agent peut faire par les outils MCP : audit, audit fix, audit fix --force, push.

```
Utilisateur (GUI) ──ajoute un dépôt, accorde les droits, corrige──▶  Tracker  ──API GitHub──▶ alertes, PR
Agent ──list_repositories / get_alerts / run_audit / fix_vulnerabilities──▶  (dans la limite des droits)
```

Le serveur n'appelle aucun LLM. L'agent n'exécute jamais `git` ni `npm` lui-même : tout passe par les outils.

---

## Installation

```bash
npm install -g @imenam/mcp-dependabot-tracker
```

Ou via `npx`, sans installation. Le serveur communique en JSON-RPC sur stdio : il est lancé par le client MCP, pas à la main. `git` et `npm` (npm 7 ou plus récent) doivent être dans le `PATH` de la machine qui exécute le serveur.

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
| Pull requests | lecture et écriture | ouvrir la pull request |
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
| `list_repositories` | — | Dépôts suivis, tous ou ceux d'une catégorie (`category`, son nom) : catégorie, alertes Dependabot ouvertes par gravité, date de la dernière lecture (et son erreur), droits de l'agent, opération en cours. |
| `get_alerts` | — | Relit sur GitHub les alertes ouvertes d'un dépôt (`repository`) et les liste de la plus grave à la moins grave : numéro, gravité, paquet, écosystème, manifeste, résumé, version corrigée, lien. |
| `run_audit` | audit | `npm audit` dans un clone temporaire : vulnérabilités par projet npm, avec la correction proposée (aucune, dans les plages déclarées, ou montée majeure qui demande `--force`). Rien n'est modifié. |
| `fix_vulnerabilities` | fix (+ force, + push) | Clone, `npm audit`, `npm audit fix` ; avec `force: true`, `npm audit fix --force` s'il reste des vulnérabilités qu'une montée majeure corrige ; avec `push: true`, commit (`commit_message`, défaut `fix(deps): resolve npm audit vulnerabilities`), push d'une nouvelle branche et pull request vers la branche analysée. Sans `push`, rien ne sort du clone : le résultat décrit ce que les corrections changent. |
| `reconnect_gui` | — | Relance le worker GUI et le réenregistre auprès du proxy. |

Un outil refuse une action dont l'agent n'a pas le droit, en le disant ; seul l'utilisateur change les droits, dans la GUI. L'agent ne peut ni ajouter ni retirer de dépôt. Un champ inconnu fait échouer l'appel. Les outils d'opération attendent la fin de l'opération.

---

## Une opération

Chaque opération travaille dans un clone temporaire (`<CLONE_DIR>/mcp-dependabot-tracker-*/repo`, `git clone --depth 1` de la branche analysée), supprimé dès qu'elle se termine, réussie, échouée ou annulée. Il reste sur le disque tant qu'une correction lancée depuis la GUI attend une décision.

La **branche analysée** se choisit par dépôt dans la GUI ; c'est la branche par défaut tant qu'aucune autre n'est choisie. L'agent l'utilise aussi, sans pouvoir en changer. Les alertes Dependabot, elles, portent toujours sur la branche par défaut, la seule que GitHub analyse : sur une autre branche, c'est `npm audit` qui mesure les vulnérabilités.

1. **Cloner le dépôt** — puis repérer les projets npm : chaque dossier dont le `package-lock.json` est suivi par git (racine, `gui/`…). Un dépôt sans lockfile fait échouer l'opération : `npm audit` en a besoin. Un lockfile v1 (npm 6) est refusé.
2. **npm audit** — `npm audit --json` dans chaque projet.
3. **npm audit fix** — `npm audit fix --package-lock-only --ignore-scripts` dans chaque projet vulnérable : seuls les lockfiles changent, sans installation de `node_modules` ni script de paquet. Puis un nouvel audit.
4. **npm audit fix --force** — proposé quand des vulnérabilités restantes ne se corrigent que par une version majeure (`fixAvailable.isSemVerMajor` du rapport npm). L'écran liste les paquets concernés, leur version installée et la version cible, et le nombre de vulnérabilités en jeu.
5. **Commit et push** — commit des fichiers modifiés sur la branche `fix/npm-audit-<AAAA-MM-JJ>-<HHMMSS>` (heure locale du serveur, fixée quand la correction est prête), push, puis pull request vers la branche analysée. Son corps donne les vulnérabilités avant et après, l'application de `--force` et les paquets mis à jour.

Les paquets mis à jour sont lus en comparant chaque lockfile à celui du commit cloné : version changée, paquet ajouté ou retiré. S'il n'y a rien à corriger, ou si les corrections ne changent rien, l'opération se termine sans push.

Depuis la GUI, l'opération s'arrête aux étapes 4 et 5 pour la décision de l'utilisateur. Menée par l'agent, elle va d'un bout à l'autre selon `force` et `push`. Une seule opération à la fois par dépôt.

**Annulation** — une opération en attente se termine aussitôt. Une opération en cours reçoit une demande d'annulation que le processus qui l'exécute lit toutes les 500 ms : il arrête la commande en cours (arbre de processus compris) et supprime le clone. Une opération dont le processus a disparu passe en échec à la lecture suivante.

---

## L'interface

Thème sombre, une information par ligne, une action principale par écran.

- **Accueil (`#/`, `#/c/<catégorie>`)** — à gauche, la barre des catégories : « Tous mes projets », puis chaque catégorie, chacune avec le nombre d'alertes ouvertes de ses dépôts, coloré selon la plus grave (aucune pastille sans alerte). « Nouvelle catégorie » ouvre un champ en place (Entrée crée, Échap annule) ; au survol d'une catégorie, « … » propose de la renommer ou de la supprimer (un second clic confirme ; ses dépôts restent suivis, sans catégorie). Un dépôt appartient à une catégorie au plus.
  À droite, les dépôts de la catégorie choisie, du plus exposé au moins exposé (gravité la plus haute, puis nombre d'alertes). L'interrupteur « Vulnérables seulement » cache les dépôts sans alerte ouverte ; le navigateur retient sa position. En bout de ligne, une seule information : le nombre d'alertes coloré selon la gravité la plus haute, « Correction en cours », « Synchronisation impossible » (l'erreur en infobulle) ou « À jour ».
  « Ajouter un dépôt » ouvre une fenêtre avec un champ de recherche et la catégorie. Dès la première lettre, jusqu'à dix dépôts accessibles au token et pas encore suivis sont proposés (ceux dont le nom commence par la saisie d'abord) ; ↑ et ↓ parcourent, Entrée ou un clic reportent le dépôt dans le champ, Échap referme la liste, puis la fenêtre. La catégorie part de celle affichée. « Ajouter » valide ; sans suggestion, Entrée aussi. La saisie peut être `propriétaire/dépôt` ou un lien GitHub. Un nouveau dépôt n'accorde que l'audit à l'agent.
- **Dépôt (`#/r/<propriétaire>/<nom>`)** — sélecteur de la branche analysée (un clic ouvre la liste des branches avec un champ de recherche, la branche par défaut en tête ; ↑ ↓ et Entrée ou un clic choisissent, Échap ferme), sélecteur de la catégorie (« Sans catégorie » ou l'une des catégories), date de la dernière lecture des alertes et lien vers la dernière correction ; les alertes ouvertes (gravité, paquet, résumé), chacune ouvrant l'alerte sur GitHub. « Corriger » lance une correction, ou « Reprendre la correction » rouvre celle en cours. « Agent » ouvre le volet des droits : quatre interrupteurs, enregistrés aussitôt, et « Retirer le dépôt » (un second clic confirme dans les 4 secondes ; refusé pendant une opération).
- **Correction (`#/r/<propriétaire>/<nom>/op/<id>`)** — qui l'a lancée (vous ou l'agent), la branche clonée, puis les étapes : celles qui sont faites tiennent sur une ligne avec leur résultat (« 4 vulnérabilités », « 3 corrigées », lien vers la pull request), seule l'étape qui attend une décision est dépliée. Une étape passée en donne la raison : « aucune correction possible » pour `--force` quand npm ne propose aucune montée majeure, « rien à corriger » quand `npm audit fix` a tout corrigé, « rien à pousser » quand les corrections n'ont rien changé, « ignorée » sinon. Les vulnérabilités sans aucune version corrigée publiée sur le registre npm (`fixAvailable: false`, par exemple `xlsx`, que SheetJS ne publie plus sur npm) sont comptées sur la ligne du dernier audit (« 1 sans correctif ») ; un clic les liste avec leur gravité : leur mise à jour est à faire à la main. L'étape `--force` liste les montées majeures avec « Appliquer --force » et « Passer » ; l'étape du push montre le message de commit modifiable, le nom de la branche, « voir les changements » (paquets mis à jour, replié) et « Pousser et ouvrir la PR ». Une erreur s'affiche sous l'étape qui a échoué. « Journal » déplie les commandes lancées et leurs résultats ; « Annuler » arrête l'opération.

Les écrans se relisent par polling : toutes les 3 s pour les listes, toutes les secondes pendant une opération.

---

## Architecture

Deux processus, selon le standard de l'écosystème (`@imenam/mcp-gui-interface`) :

- **Maître MCP** (`src/index.ts`) — JSON-RPC sur stdio, outils (`src/tools/`), logique (`src/core/`), relecture des alertes toutes les 10 minutes, cycle de vie du worker via `GuiLauncher`.
- **Worker GUI** (`src/gui-worker.ts`) — Hono, enregistrement auprès du proxy ou écoute sur `APP_PORT`, API REST transmise au maître par IPC, fichiers de la SPA avec la balise `<base>` du chemin de montage. Il écoute sur `127.0.0.1` derrière `honoGuiGuard`.

| Route | Effet |
|---|---|
| `GET /api/config` | Version, répertoire des données, présence du token. |
| `GET /api/repos`, `POST /api/repos` | Dépôts suivis (avec catégorie, opération en cours et dernière opération) et catégories ; ajout d'un dépôt (`{ repository, categoryId? }`). |
| `GET /api/github/repos` | Dépôts accessibles au token (`/user/repos`) et pas encore suivis, pour les suggestions d'ajout. |
| `GET` / `DELETE /api/repos/:propriétaire/:nom` | Dépôt ; retrait. |
| `PUT /api/repos/:propriétaire/:nom/rights` | Droits de l'agent. |
| `GET /api/repos/:propriétaire/:nom/branches`, `PUT …/branch` | Branches du dépôt, la branche par défaut en tête ; choix de la branche analysée (`{ branch }`, qui doit exister). |
| `PUT /api/repos/:propriétaire/:nom/category` | Catégorie du dépôt (`{ categoryId }`, null pour aucune). |
| `GET /api/categories`, `POST /api/categories` | Catégories dans l'ordre alphabétique ; création (`{ name }`, unique sans tenir compte de la casse). |
| `PUT` / `DELETE /api/categories/:id` | Renommage (`{ name }`) ; suppression, ses dépôts restant sans catégorie. |
| `POST /api/repos/:propriétaire/:nom/operations` | Lance une correction. |
| `GET /api/operations/:id` | Opération. |
| `POST /api/operations/:id/force`, `/push`, `/cancel` | Décision `--force` (`{ apply }`), push (`{ commitMessage }`), annulation. |

Erreurs : `400` requête invalide, `404` introuvable, `409` conflit (opération déjà en cours, étape qui n'attend pas cette décision), `500` sinon.

### Persistance

`<données>/repos.json` pour les catégories et les dépôts (catégorie, droits, alertes, dernière lecture) et `<données>/operations/<id>.json` pour chaque opération ; les 20 plus récentes sont conservées par dépôt. Plusieurs instances du serveur (une par session d'agent) partagent le répertoire : les écritures sont atomiques et passent par le verrou `<données>/data.lock`. Une opération lancée par une instance se poursuit, s'annule ou se décide depuis la GUI d'une autre.

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

Les tests utilisent une fausse API GitHub (dépôts, alertes paginées, utilisateur, pull requests) et des dépôts nus locaux servis par `file://` (`GITHUB_API_URL`, `GITHUB_SERVER_URL`). `test/operations.test.ts` et `test/server.test.ts` lancent un vrai `npm audit` sur un petit projet vulnérable (`test/fixtures/vulnerable` : `lodash`, corrigé par `audit fix`, et `nth-check`, corrigé seulement par `--force`) : ils ont besoin du registre npm et sont ignorés, avec la raison, s'il est injoignable. `test/server.test.ts` lance le serveur sur stdio avec sa GUI sur un port libre et parcourt les outils, les droits et la correction complète depuis l'API de la GUI.
