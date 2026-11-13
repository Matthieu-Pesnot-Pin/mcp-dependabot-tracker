import fs from "fs";
import path from "path";

const SERVER_NAME = "mcp-dependabot-tracker";
export const PACKAGE_NAME = "@imenam/mcp-dependabot-tracker";

/** Ce que le mode MCP doit connaître : l'adresse du serveur et un token d'agent. */
export interface McpConnection {
  serverUrl: string;
  token: string;
}

/** Commande qui déclare le mode MCP avec `connection` dans le `.mcp.json` du répertoire courant. */
export function setupCommand({ serverUrl, token }: McpConnection): string {
  return `npx -y ${PACKAGE_NAME} --claude-setup-mcp --server_url=${serverUrl} --token=${token}`;
}

function buildServerEntry({ serverUrl, token }: McpConnection) {
  return {
    command: "npx",
    args: ["-y", PACKAGE_NAME, "mcp"],
    env: { SERVER_URL: serverUrl, AGENT_TOKEN: token },
  };
}

/** Lit `--flag=valeur` (tirets ou underscores acceptés). */
function readFlag(argv: string[], name: string): string | undefined {
  const prefixes = [`--${name}=`, `--${name.replace(/_/g, "-")}=`];
  for (const arg of argv) {
    const prefix = prefixes.find((p) => arg.startsWith(p));
    if (prefix) return arg.slice(prefix.length).trim();
  }
  return undefined;
}

/** Valide une adresse de serveur http ou https ; rend l'adresse sans barre finale, ou la raison du refus. */
export function parseServerUrl(raw: string, label: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `${label} invalide : "${raw}" n'est pas une URL absolue (ex : http://localhost:4700).` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `${label} invalide : protocole "${parsed.protocol}" non supporté (http ou https attendu).` };
  }
  return { url: raw.replace(/\/+$/, "") };
}

/** Lit `--server_url=` et `--token=`, tous deux obligatoires. */
export function parseConnection(argv: string[]): { connection: McpConnection } | { error: string } {
  const rawUrl = readFlag(argv, "server_url");
  const token = readFlag(argv, "token");
  if (!rawUrl) return { error: "--server_url est obligatoire : l'adresse du serveur Dependabot Tracker, ex : --server_url=http://localhost:4700" };
  if (!token) return { error: "--token est obligatoire : un token d'agent, créé dans les réglages de l'interface du serveur." };
  const url = parseServerUrl(rawUrl, "--server_url");
  if ("error" in url) return url;
  return { connection: { serverUrl: url.url, token } };
}

export interface SetupMcpOptions {
  cwd: string;
  force: boolean;
  connection: McpConnection;
}

/** Crée ou complète le `.mcp.json` de `cwd` avec l'entrée du mode MCP ; rend le code de sortie de la commande. */
export function runSetupMcp({ cwd, force, connection }: SetupMcpOptions): number {
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

  config.mcpServers[SERVER_NAME] = buildServerEntry(connection);

  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const action = alreadyPresent ? "remplacée" : exists ? "ajoutée" : "créée";
  console.log(`Configuration ${SERVER_NAME} ${action} dans ${target}`);
  console.log(`Le mode MCP se connecte au serveur ${connection.serverUrl}.`);
  return 0;
}
