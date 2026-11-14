import net from "net";

/** Configuration du serveur standalone lue dans l'environnement. */
export interface ServerConfig {
  /** Port d'écoute. */
  port: number;
  /** Adresse IP d'écoute : LISTEN_HOST, la boucle locale `127.0.0.1` par défaut. */
  listenHost: string;
  /** Adresse publique de l'interface, sans barre finale (origine seule). */
  appUrl: string;
  /** Secret de signature des sessions, 32 caractères au moins. */
  authSecret: string;
  /** Adresses ou plages CIDR des reverse proxies dont l'en-tête X-Forwarded-For est cru. */
  trustedProxies: string[];
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const MIN_SECRET_LENGTH = 32;

function readPort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) throw new Error("APP_PORT is not set: declare the port the server listens on.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`APP_PORT is invalid (${value}): expected an integer between 1 and 65535.`);
  return port;
}

/** Valide APP_URL : http(s), sans chemin ; le http n'est admis que sur la boucle locale. */
function readAppUrl(raw: string | undefined): { appUrl: string; loopback: boolean } {
  const value = raw?.trim();
  if (!value) throw new Error("APP_URL is not set: declare the public address of the interface (e.g. https://deps.example.com).");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`APP_URL is not a valid URL (${value}).`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`APP_URL must use https (${value}).`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`APP_URL must be an origin without path (${value}): the interface is served at the root.`);
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(`APP_URL must use https (${value}): http is only accepted on localhost, where nothing leaves the machine.`);
  }
  return { appUrl: url.origin, loopback: loopback && url.protocol === "http:" };
}

function readSecret(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error('AUTH_SECRET is not set: generate one with "mcp-dependabot-tracker --generate-auth-secret".');
  if (value.length < MIN_SECRET_LENGTH) throw new Error(`AUTH_SECRET is too short (${value.length} characters): at least ${MIN_SECRET_LENGTH} are required.`);
  return value;
}

/** Vrai pour une adresse de la boucle locale (`127.0.0.0/8`, `::1`). */
function isLoopbackAddress(address: string): boolean {
  return address === "::1" || (net.isIPv4(address) && address.startsWith("127."));
}

/**
 * Lit LISTEN_HOST : une adresse IP de la machine, `0.0.0.0` ou `::` pour toutes
 * les interfaces ; `127.0.0.1` sans valeur. Avec une APP_URL en http, seule la
 * boucle locale est admise : rien ne doit transiter en clair hors de la machine.
 */
export function readListenHost(raw: string | undefined, httpAppUrl: boolean): string {
  const value = raw?.trim() || DEFAULT_LISTEN_HOST;
  if (net.isIP(value) === 0) throw new Error(`LISTEN_HOST is not an IP address (${value}): expected e.g. 127.0.0.1, or 0.0.0.0 for every interface.`);
  if (httpAppUrl && !isLoopbackAddress(value)) {
    throw new Error(`LISTEN_HOST must be a loopback address with an http APP_URL (${value}): use https in APP_URL to listen beyond this machine.`);
  }
  return value;
}

/** Lit TRUSTED_PROXIES : liste d'adresses IP ou de plages CIDR séparées par des virgules. */
export function parseTrustedProxies(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split("/");
    const family = net.isIP(address);
    const maxPrefix = family === 4 ? 32 : 128;
    const validPrefix = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (family === 0 || !validPrefix || rest.length > 0) throw new Error(`TRUSTED_PROXIES holds an invalid entry (${entry}): expected an IP address or a CIDR range.`);
  }
  return entries;
}

/** Ce dont l'authentification a besoin : adresse publique, secret, proxies de confiance. */
export type AuthEnv = Pick<ServerConfig, "appUrl" | "authSecret" | "trustedProxies">;

/** Réglages de l'authentification ; lève une erreur qui nomme la variable manquante ou invalide. */
export function readAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv & { loopback: boolean } {
  const { appUrl, loopback } = readAppUrl(env.APP_URL);
  return { appUrl, loopback, authSecret: readSecret(env.AUTH_SECRET), trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES) };
}

/** Configuration du serveur ; lève une erreur qui nomme la variable manquante ou invalide. */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = readPort(env.APP_PORT);
  const { loopback, ...auth } = readAuthEnv(env);
  return { port, listenHost: readListenHost(env.LISTEN_HOST, loopback), ...auth };
}
