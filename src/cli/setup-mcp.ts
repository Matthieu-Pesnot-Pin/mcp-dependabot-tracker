import fs from "fs";
import path from "path";

const SERVER_NAME = "mcp-dependabot-tracker";
const PACKAGE_NAME = "@imenam/mcp-dependabot-tracker";

/**
 * Comment la GUI sera exposée. `undefined` des deux côtés = rien n'a été passé
 * en ligne de commande : on retombe sur le placeholder PROXY_URL à compléter.
 */
export interface GuiExposure {
  proxyUrl?: string;
  appPort?: number;
}

/**
 * Valeurs volontairement vides : chaque variable est inactive tant qu'elle n'est
 * pas remplie (PROXY_URL et APP_PORT vides = GUI désactivée), sauf CLONE_DIR,
 * obligatoire. Les dépôts suivis ne dépendent pas du projet : le répertoire des
 * données reste celui par défaut.
 */
function buildServerEntry(exposure: GuiExposure) {
  // Un port explicite désactive le placeholder proxy : les deux variables ne
  // doivent jamais être renseignées ensemble, PROXY_URL primant au runtime.
  const proxyUrl = exposure.appPort !== undefined ? "" : exposure.proxyUrl ?? "http://localhost:";
  return {
    command: "npx",
    args: ["-y", PACKAGE_NAME],
    env: {
      GITHUB_TOKEN: "",
      PROXY_URL: proxyUrl,
      APP_PORT: exposure.appPort !== undefined ? String(exposure.appPort) : "",
      APP_GROUP: "",
      APP_NAME: "Dependabot Tracker",
      APP_PATH: "/dependabot-tracker",
      CLONE_DIR: "",
      MCP_DATA_DIR: "",
      MCP_LOG_DIR: "",
    },
  };
}

const GENERATED_VARS = [
  ["GITHUB_TOKEN", "token GitHub : Dependabot alerts (lecture), Contents et Pull requests (lecture et écriture)"],
  ["PROXY_URL", "URL du proxy pour exposer la GUI (compléter le port)"],
  ["APP_PORT", "port local si aucun proxy — la GUI est servie sur http://localhost:<port>"],
  ["APP_GROUP", "groupe d'affichage dans le dashboard du proxy"],
  ["APP_NAME", "nom affiché de la GUI dans le dashboard du proxy"],
  ["APP_PATH", "chemin de montage de la GUI derrière le proxy"],
  ["CLONE_DIR", "dossier des clones temporaires, créé s'il n'existe pas (obligatoire)"],
  ["MCP_DATA_DIR", "répertoire des données (défaut : ~/.mcp-dependabot-tracker)"],
  ["MCP_LOG_DIR", "répertoire des logs (défaut : <données>/logs)"],
];

/** Lit `--flag=valeur` (tirets ou underscores acceptés). */
function readFlag(argv: string[], name: string): string | undefined {
  const prefixes = [`--${name}=`, `--${name.replace(/_/g, "-")}=`];
  for (const arg of argv) {
    const prefix = prefixes.find((p) => arg.startsWith(p));
    if (prefix) return arg.slice(prefix.length).trim();
  }
  return undefined;
}

/**
 * Traduit `--proxy_url=` / `--app_port=` en mode d'exposition de la GUI.
 * Les deux ensemble sont refusés : au runtime PROXY_URL primerait toujours,
 * donc un fichier portant les deux serait silencieusement trompeur.
 */
export function parseGuiExposure(argv: string[]): { exposure: GuiExposure } | { error: string } {
  const rawProxyUrl = readFlag(argv, "proxy_url");
  const rawAppPort = readFlag(argv, "app_port");

  if (rawProxyUrl !== undefined && rawAppPort !== undefined) {
    return { error: "--proxy_url et --app_port sont exclusifs : la GUI passe par le proxy, ou écoute sur un port local." };
  }

  if (rawProxyUrl !== undefined) {
    if (rawProxyUrl === "") return { error: "--proxy_url attend une URL, ex : --proxy_url=http://localhost:3000" };
    let parsed: URL;
    try {
      parsed = new URL(rawProxyUrl);
    } catch {
      return { error: `--proxy_url invalide : "${rawProxyUrl}" n'est pas une URL absolue (ex : http://localhost:3000).` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `--proxy_url invalide : protocole "${parsed.protocol}" non supporté (http ou https attendu).` };
    }
    // Une barre finale casserait la concaténation PROXY_URL + APP_PATH.
    return { exposure: { proxyUrl: rawProxyUrl.replace(/\/+$/, "") } };
  }

  if (rawAppPort !== undefined) {
    const port = Number(rawAppPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `--app_port invalide : "${rawAppPort}" n'est pas un entier entre 1 et 65535.` };
    }
    return { exposure: { appPort: port } };
  }

  return { exposure: {} };
}

export interface SetupMcpOptions {
  cwd: string;
  force: boolean;
  exposure?: GuiExposure;
}

export function runSetupMcp({ cwd, force, exposure = {} }: SetupMcpOptions): number {
  const target = path.join(cwd, ".mcp.json");

  let config: any = {};
  const exists = fs.existsSync(target);

  if (exists) {
    const raw = fs.readFileSync(target, "utf-8").trim();
    if (raw !== "") {
      try {
        config = JSON.parse(raw);
      } catch (err: any) {
        console.error(`Erreur : ${target} contient du JSON invalide (${err.message}).`);
        console.error("Corrigez le fichier ou supprimez-le, puis relancez la commande.");
        return 1;
      }
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      console.error(`Erreur : ${target} ne contient pas un objet JSON.`);
      return 1;
    }
  }

  if (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  const alreadyPresent = Object.prototype.hasOwnProperty.call(config.mcpServers, SERVER_NAME);
  if (alreadyPresent && !force) {
    console.error(`Le serveur "${SERVER_NAME}" est déjà configuré dans ${target}.`);
    console.error("Relancez avec --force pour écraser cette entrée (les autres serveurs sont préservés).");
    return 1;
  }

  config.mcpServers[SERVER_NAME] = buildServerEntry(exposure);

  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const action = alreadyPresent ? "remplacée" : exists ? "ajoutée" : "créée";
  console.log(`Configuration ${SERVER_NAME} ${action} dans ${target}`);
  console.log("");

  if (exposure.appPort !== undefined) {
    console.log(`GUI en accès direct : http://localhost:${exposure.appPort} (sans proxy).`);
  } else if (exposure.proxyUrl !== undefined) {
    console.log(`GUI exposée via le proxy ${exposure.proxyUrl}.`);
  }

  console.log('À compléter dans le champ "env" :');
  for (const [name, description] of GENERATED_VARS) {
    console.log(`  ${name.padEnd(16)} ${description}`);
  }
  console.log("");
  console.log("Une variable laissée vide est simplement inactive, sauf CLONE_DIR : sans elle, le serveur refuse de démarrer.");
  console.log("PROXY_URL et APP_PORT s'excluent : PROXY_URL prime si les deux sont renseignés.");

  return 0;
}
