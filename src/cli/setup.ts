import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import { addUser, closeAuth, createAuth, generateAuthSecret, listUsers, migrateAuth } from "../core/auth.js";
import { readServerConfig } from "../core/server-config.js";
import {
  SERVICE_NAME,
  mergeEnvFile,
  nextFreeSubIdRange,
  renderNginxSite,
  renderSystemdUnit,
  subIdRangesOf,
  type ServiceLayout,
} from "../core/setup-files.js";
import { generateVaultKey } from "../core/vault.js";
import { promptHidden, promptLine } from "./prompt.js";

/**
 * Commande `setup` : installation complète du serveur sur une machine Linux
 * avec systemd, lancée en root. Elle pose ses questions (adresse publique,
 * port, compte de service, données, nginx et certificat, premier compte), en
 * proposant les valeurs du `.env` existant, puis : installe les paquets
 * manquants, crée le compte de service, lui attribue une plage libre de
 * sous-identifiants et active son lingering, écrit le `.env` (clés générées
 * une fois, puis conservées), crée le premier compte de l'interface, prépare
 * Podman rootless, écrit et démarre l'unité systemd, vérifie que le serveur
 * répond, puis configure nginx et le certificat quand ils sont demandés.
 * Relancée, elle reprend la configuration en place.
 */

export const SETUP_USAGE = `Usage : mcp-dependabot-tracker setup [options]

Installe le serveur sur cette machine (Linux, systemd), en root. Les questions
proposent les valeurs du .env existant ; sans terminal, ou avec --non-interactive,
chaque réponse vient d'une option, sinon du .env existant ou du défaut.

  --app-url=<url>          adresse publique de l'interface (https://…)
  --port=<n>               port d'écoute, sur 127.0.0.1               [4700]
  --service-user=<compte>  compte système du service                  [${SERVICE_NAME}]
  --data-dir=<chemin>      répertoire des données                     [<dossier du compte>/data]
  --nginx=oui|non          servir l'adresse publique par nginx        [oui en https]
  --certbot=oui|non        obtenir le certificat avec certbot         [oui avec nginx]
  --admin-email=<adresse>  premier compte de l'interface
  --admin-name=<nom>       nom affiché de ce compte
  --non-interactive        ne rien demander

Le mot de passe du compte n'est jamais un argument : il est saisi sans écho, ou
lu dans SETUP_ADMIN_PASSWORD.`;

const VALUE_OPTIONS = ["app-url", "port", "service-user", "data-dir", "nginx", "certbot", "admin-email", "admin-name"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

/** Paquets nécessaires au serveur : git, Podman rootless, et le bac à sable de Claude Code. */
export const BASE_PACKAGES = ["git", "podman", "uidmap", "passt", "slirp4netns", "catatonit", "bubblewrap", "socat"];

const DEFAULT_PORT = "4700";
const MIN_PASSWORD_LENGTH = 12;
const HEALTH_TIMEOUT_MS = 30_000;
const RUNTIME_DIR_TIMEOUT_MS = 10_000;

class SetupError extends Error {}

function fail(message: string): never {
  throw new SetupError(message);
}

/** Résultat d'une commande système. */
export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Ce que la commande touche sur la machine ; remplaçable dans les tests. */
export interface SetupHost {
  platform: NodeJS.Platform;
  isRoot: boolean;
  interactive: boolean;
  /** Racine des fichiers système (`/etc`, `/run`) : `/` sur la machine. */
  root: string;
  packageRoot: string;
  nodePath: string;
  /** Lance une commande ; `inherit` montre sa sortie à l'utilisateur. */
  run: (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; inherit?: boolean }) => CommandOutcome;
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
  say: (line: string) => void;
  /** Attend que le serveur réponde sur `port` ; rend faux après `timeoutMs`. */
  waitHealthy: (port: number, timeoutMs: number) => Promise<boolean>;
}

/** Machine réelle : commandes, terminal et fichiers de la machine. */
export function realHost(packageRoot: string): SetupHost {
  return {
    platform: process.platform,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    interactive: process.stdin.isTTY === true,
    root: "/",
    packageRoot,
    nodePath: process.execPath,
    run: (command, args, options = {}) => {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        encoding: "utf-8",
        stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      });
      if (result.error) return { code: 127, stdout: "", stderr: result.error.message };
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    ask: (question) => promptLine(`${question} : `),
    askSecret: (question) => promptHidden(`${question} : `),
    say: (line) => process.stdout.write(`${line}\n`),
    waitHealthy: async (port, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false);
        if (ok) return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return false;
    },
  };
}

// --- Options et questions ------------------------------------------------------

interface ParsedArgs {
  values: Partial<Record<ValueOption, string>>;
  nonInteractive: boolean;
}

/** Lit les options `--nom=valeur` ; une option inconnue ou répétée est refusée. */
export function parseSetupArgs(argv: readonly string[]): ParsedArgs {
  const values: Partial<Record<ValueOption, string>> = {};
  let nonInteractive = false;
  for (const arg of argv) {
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) fail(`Argument inattendu : « ${arg} ».\n\n${SETUP_USAGE}`);
    const [, name, value] = match;
    if (name === "admin-password" || name === "password") fail("Le mot de passe ne se passe pas en argument, qui reste lisible dans l'historique et la liste des processus : saisissez-le, ou définissez SETUP_ADMIN_PASSWORD.");
    if (!(VALUE_OPTIONS as readonly string[]).includes(name)) fail(`Option inconnue : --${name}.\n\n${SETUP_USAGE}`);
    if (values[name as ValueOption] !== undefined) fail(`--${name} est donné plusieurs fois.`);
    values[name as ValueOption] = value.trim();
  }
  return { values, nonInteractive };
}

interface Question<T> {
  option: ValueOption;
  question: string;
  validate: (raw: string) => T;
  /** Valeur en place (`.env`, compte existant) ou défaut, proposée et retenue sans terminal. */
  proposed?: string;
}

class Prompter {
  constructor(
    private readonly host: SetupHost,
    private readonly args: ParsedArgs
  ) {}

  get interactive(): boolean {
    return this.host.interactive && !this.args.nonInteractive;
  }

  provided(option: ValueOption): string | undefined {
    return this.args.values[option];
  }

  /** Réponse : option, puis saisie (valeur proposée sur Entrée), ou valeur proposée sans terminal. */
  async value<T>(spec: Question<T>): Promise<T> {
    const given = this.provided(spec.option);
    if (given !== undefined) {
      try {
        const value = spec.validate(given);
        this.host.say(`  ${spec.question} : ${given}`);
        return value;
      } catch (err: any) {
        fail(`--${spec.option} : ${err.message}`);
      }
    }
    if (!this.interactive) {
      if (spec.proposed === undefined) fail(`Sans terminal, --${spec.option} est requis (${spec.question.toLowerCase()}).`);
      try {
        const value = spec.validate(spec.proposed);
        this.host.say(`  ${spec.question} : ${spec.proposed}`);
        return value;
      } catch (err: any) {
        fail(`${spec.question} : la valeur ${spec.proposed} est invalide, ${err.message} Passez --${spec.option}.`);
      }
    }
    for (;;) {
      const raw = await this.host.ask(`${spec.question}${spec.proposed !== undefined ? ` [${spec.proposed}]` : ""}`);
      const candidate = raw === "" ? spec.proposed : raw;
      if (candidate === undefined) {
        this.host.say("  ! Une réponse est attendue.");
        continue;
      }
      try {
        return spec.validate(candidate);
      } catch (err: any) {
        this.host.say(`  ! ${err.message}`);
      }
    }
  }
}

function validateAppUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`« ${raw} » n'est pas une adresse : attendu par exemple https://deps.example.com.`);
  }
  if (url.protocol !== "https:") throw new Error("une adresse en https est attendue : le serveur installé est servi derrière un reverse proxy qui porte le certificat.");
  if (url.pathname !== "/" || url.search || url.hash || url.username) throw new Error("l'adresse ne doit avoir ni chemin, ni paramètres, ni identifiants : l'interface est servie à la racine.");
  return url;
}

function validatePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error(`port invalide (${raw}) : un entier entre 1 et 65535.`);
  return port;
}

function validateServiceUser(raw: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(raw)) throw new Error(`compte invalide (${raw}) : minuscules, chiffres, « _ » et « - ».`);
  return raw;
}

function validateAbsolutePath(raw: string): string {
  if (!path.isAbsolute(raw)) throw new Error(`chemin absolu attendu (${raw}).`);
  return path.resolve(raw);
}

function validateBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (["o", "oui", "y", "yes"].includes(value)) return true;
  if (["n", "non", "no"].includes(value)) return false;
  throw new Error(`réponse invalide (${raw}) : oui ou non.`);
}

function validateEmail(raw: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new Error(`adresse e-mail invalide (${raw}).`);
  return raw.toLowerCase();
}

function validateName(raw: string): string {
  if (raw.trim() === "") throw new Error("nom vide.");
  return raw.trim();
}

// --- Système -------------------------------------------------------------------

/** Chemin d'un fichier système sous la racine de l'hôte. */
function sys(host: SetupHost, file: string): string {
  return path.join(host.root, file);
}

function readIfExists(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
}

/** Lance une commande et lève une erreur qui cite sa sortie si elle échoue. */
function must(host: SetupHost, command: string, args: string[], options: Parameters<SetupHost["run"]>[2] = {}): CommandOutcome {
  const result = host.run(command, args, options);
  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-6).join("\n");
    fail(`« ${[command, ...args].join(" ")} » a échoué (code ${result.code})${output ? ` :\n${output}` : "."}`);
  }
  return result;
}

/** Compte système d'après `getent passwd`, ou null s'il n'existe pas. */
function accountOf(host: SetupHost, user: string): { uid: number; gid: number; home: string } | null {
  const result = host.run("getent", ["passwd", user]);
  if (result.code !== 0) return null;
  const [, , uid, gid, , home] = result.stdout.trim().split(":");
  return { uid: Number(uid), gid: Number(gid), home };
}

/** Paquets de `wanted` qui ne sont pas installés. */
function missingPackages(host: SetupHost, wanted: string[]): string[] {
  return wanted.filter((name) => !host.run("dpkg-query", ["-W", "-f=${Status}", name]).stdout.includes("install ok installed"));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Site nginx déjà activé, autre que celui du tracker, qui sert `hostname`. */
function nginxSiteServing(host: SetupHost, hostname: string): string | null {
  const dir = sys(host, "/etc/nginx/sites-enabled");
  if (!fs.existsSync(dir)) return null;
  const pattern = new RegExp(`server_name[^;]*\\s${hostname.replace(/\./g, "\\.")}[\\s;]`);
  for (const entry of fs.readdirSync(dir)) {
    if (entry === SERVICE_NAME) continue;
    const text = readIfExists(path.join(dir, entry));
    if (text !== undefined && pattern.test(text)) return path.join("/etc/nginx/sites-enabled", entry);
  }
  return null;
}

// --- Commande ------------------------------------------------------------------

interface AccountPlan {
  email: string;
  name: string;
  password: string;
}

async function readPassword(host: SetupHost, prompter: Prompter): Promise<string> {
  const fromEnv = process.env.SETUP_ADMIN_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < MIN_PASSWORD_LENGTH) fail(`SETUP_ADMIN_PASSWORD doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
    host.say("  Mot de passe : repris de SETUP_ADMIN_PASSWORD.");
    return fromEnv;
  }
  if (!prompter.interactive) fail("Sans terminal, SETUP_ADMIN_PASSWORD est requis pour créer le compte.");
  for (;;) {
    const first = await host.askSecret(`Mot de passe, non affiché (${MIN_PASSWORD_LENGTH} caractères minimum)`);
    if (first.length < MIN_PASSWORD_LENGTH) {
      host.say(`  ! Au moins ${MIN_PASSWORD_LENGTH} caractères.`);
      continue;
    }
    if ((await host.askSecret("Confirmation")) !== first) {
      host.say("  ! Les deux saisies diffèrent.");
      continue;
    }
    return first;
  }
}

/** Comptes de l'interface déjà créés dans `dataDir`. */
async function existingAccounts(dataDir: string, env: Record<string, string>): Promise<number> {
  if (!fs.existsSync(path.join(dataDir, "auth.sqlite"))) return 0;
  const auth = createAuth(dataDir, readServerConfig(env));
  try {
    await migrateAuth(auth);
    return (await listUsers(auth)).length;
  } finally {
    closeAuth(auth);
  }
}

async function planAccount(host: SetupHost, prompter: Prompter, count: number): Promise<AccountPlan | null> {
  if (count > 0 && prompter.provided("admin-email") === undefined) {
    const answer = prompter.interactive ? await host.ask(`${count} compte(s) existe(nt) déjà. Adresse d'un compte à ajouter (Entrée pour aucun)`) : "";
    if (answer === "") {
      host.say(`  Comptes : inchangés (${count}).`);
      return null;
    }
    const email = validateEmail(answer);
    return { email, name: await prompter.value({ option: "admin-name", question: "Nom affiché", validate: validateName }), password: await readPassword(host, prompter) };
  }
  const email = await prompter.value({ option: "admin-email", question: "Adresse e-mail du premier compte", validate: validateEmail });
  const name = await prompter.value({ option: "admin-name", question: "Nom affiché", validate: validateName });
  return { email, name, password: await readPassword(host, prompter) };
}

/** Exécute la commande ; rend le code de sortie. */
export async function runSetup(argv: readonly string[], host: SetupHost): Promise<number> {
  const step = (title: string) => host.say(`\n== ${title}`);
  try {
    const args = parseSetupArgs(argv);
    if (host.platform !== "linux") fail("setup installe un service systemd : lancez-le sur le serveur Linux qui hébergera le tracker.");
    if (!host.isRoot) fail("setup crée un compte système et écrit dans /etc : relancez-le en root (sudo).");
    if (host.run("systemctl", ["--version"]).code !== 0) fail("systemd est introuvable (systemctl) : setup installe un service systemd.");
    const prompter = new Prompter(host, args);

    const envFile = path.join(host.packageRoot, ".env");
    const existingText = readIfExists(envFile);
    const existing = existingText === undefined ? {} : dotenv.parse(existingText);
    const kept = (key: string) => (existing[key] ? existing[key] : undefined);

    host.say("Dependabot Tracker — installation du serveur");
    host.say(existingText === undefined ? `  Nouvelle configuration : ${envFile}` : `  Configuration existante reprise : ${envFile}`);

    step("Adresse");
    const appUrl = await prompter.value({ option: "app-url", question: "Adresse publique de l'interface", proposed: kept("APP_URL"), validate: validateAppUrl });
    const port = await prompter.value({ option: "port", question: "Port d'écoute (sur 127.0.0.1)", proposed: kept("APP_PORT") ?? DEFAULT_PORT, validate: validatePort });

    step("Compte de service et données");
    const serviceUser = await prompter.value({ option: "service-user", question: "Compte système du service", proposed: SERVICE_NAME, validate: validateServiceUser });
    const current = accountOf(host, serviceUser);
    const home = current?.home ?? `/var/lib/${serviceUser}`;
    const dataDir = await prompter.value({ option: "data-dir", question: "Répertoire des données", proposed: kept("DATA_DIR") ?? `${home}/data`, validate: validateAbsolutePath });

    step("Reverse proxy");
    const nginx = await prompter.value({ option: "nginx", question: `Servir ${appUrl.hostname} par nginx`, proposed: "oui", validate: validateBoolean });
    const servedBy = nginx ? nginxSiteServing(host, appUrl.hostname) : null;
    if (servedBy) host.say(`  nginx sert déjà ${appUrl.hostname} (${servedBy}) : ce site est gardé tel quel.`);
    const certbot = nginx && !servedBy ? await prompter.value({ option: "certbot", question: "Obtenir le certificat avec certbot", proposed: "oui", validate: validateBoolean }) : false;
    if (!nginx) host.say(`  Le reverse proxy qui porte le certificat de ${appUrl.hostname} doit joindre 127.0.0.1:${port}.`);

    const values: Record<string, string> = {
      DATA_DIR: dataDir,
      APP_URL: appUrl.origin,
      APP_PORT: String(port),
      AUTH_SECRET: kept("AUTH_SECRET") ?? generateAuthSecret(),
      VAULT_KEY: kept("VAULT_KEY") ?? generateVaultKey(),
      TRUSTED_PROXIES: kept("TRUSTED_PROXIES") ?? "127.0.0.1",
    };
    const env = { ...existing, ...values };
    try {
      readServerConfig(env);
    } catch (err: any) {
      fail(err.message);
    }

    step("Premier compte de l'interface");
    const account = await planAccount(host, prompter, await existingAccounts(dataDir, env));
    const certbotEmail = certbot ? (account?.email ?? (await prompter.value({ option: "admin-email", question: "Adresse e-mail pour Let's Encrypt", validate: validateEmail }))) : null;

    if (prompter.interactive) {
      const go = validateBoolean((await host.ask("\nTout est prêt. Lancer l'installation ? [oui]")) || "oui");
      if (!go) fail("installation abandonnée, rien n'a été modifié.");
    }

    step("Paquets");
    const packages = [...BASE_PACKAGES, ...(nginx && !servedBy ? ["nginx"] : []), ...(certbot ? ["certbot", "python3-certbot-nginx"] : [])];
    const missing = missingPackages(host, packages);
    if (missing.length === 0) host.say("  Tous présents.");
    else {
      host.say(`  Installation : ${missing.join(" ")}`);
      must(host, "apt-get", ["update"], { inherit: true, env: { DEBIAN_FRONTEND: "noninteractive" } });
      must(host, "apt-get", ["install", "-y", ...missing], { inherit: true, env: { DEBIAN_FRONTEND: "noninteractive" } });
    }

    step("Compte de service");
    if (current) host.say(`  ${serviceUser} existe (uid ${current.uid}, ${current.home}).`);
    else {
      must(host, "useradd", ["--system", "--user-group", "--create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", serviceUser]);
      host.say(`  ${serviceUser} créé (${home}).`);
    }
    const accountInfo = accountOf(host, serviceUser) ?? fail(`le compte ${serviceUser} est introuvable après sa création.`);
    const group = must(host, "id", ["-gn", serviceUser]).stdout.trim();
    const subuid = readIfExists(sys(host, "/etc/subuid")) ?? "";
    const subgid = readIfExists(sys(host, "/etc/subgid")) ?? "";
    if (subIdRangesOf(subuid, serviceUser).length > 0 && subIdRangesOf(subgid, serviceUser).length > 0) {
      host.say("  Sous-identifiants : plage déjà attribuée.");
    } else {
      const range = nextFreeSubIdRange(subuid, subgid);
      const spec = `${range.start}-${range.start + range.count - 1}`;
      must(host, "usermod", ["--add-subuids", spec, "--add-subgids", spec, serviceUser]);
      host.say(`  Sous-identifiants : ${spec}.`);
    }
    must(host, "loginctl", ["enable-linger", serviceUser]);
    const runtimeDir = `/run/user/${accountInfo.uid}`;
    if (!(await waitFor(() => fs.existsSync(sys(host, runtimeDir)), RUNTIME_DIR_TIMEOUT_MS))) {
      fail(`${runtimeDir} n'existe pas malgré le lingering : vérifiez « loginctl show-user ${serviceUser} ».`);
    }
    host.say(`  Lingering actif (${runtimeDir}).`);

    step("Configuration");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(envFile, mergeEnvFile(existingText, values), { mode: 0o640 });
    fs.chmodSync(envFile, 0o640);
    must(host, "chown", [`root:${group}`, envFile]);
    host.say(`  ${envFile} (lisible par root et ${group} seulement)`);

    if (account) {
      const auth = createAuth(dataDir, readServerConfig(env));
      try {
        await migrateAuth(auth);
        const user = await addUser(auth, account);
        host.say(`  Compte ${user.email} créé.`);
      } finally {
        closeAuth(auth);
      }
    }
    must(host, "chown", ["-R", `${serviceUser}:${group}`, dataDir]);

    step("Podman");
    const asService = (command: string[]) => must(host, "runuser", ["-u", serviceUser, "--", "env", `XDG_RUNTIME_DIR=${runtimeDir}`, ...command], { cwd: accountInfo.home });
    asService(["podman", "system", "migrate"]);
    const rootless = asService(["podman", "info", "--format", "{{.Host.Security.Rootless}}"]).stdout.trim();
    if (rootless !== "true") fail(`Podman ne tourne pas en rootless sous ${serviceUser} (podman info : ${rootless || "rien"}).`);
    host.say(`  Rootless sous ${serviceUser}.`);

    step("Service");
    const layout: ServiceLayout = { serviceUser, serviceGroup: group, uid: accountInfo.uid, home: accountInfo.home, dataDir, packageRoot: host.packageRoot, nodePath: host.nodePath, port };
    const unitFile = sys(host, `/etc/systemd/system/${SERVICE_NAME}.service`);
    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    fs.writeFileSync(unitFile, renderSystemdUnit(layout));
    host.say(`  /etc/systemd/system/${SERVICE_NAME}.service`);
    const dropIns = sys(host, `/etc/systemd/system/${SERVICE_NAME}.service.d`);
    if (fs.existsSync(dropIns) && fs.readdirSync(dropIns).length > 0) {
      host.say(`  Attention : /etc/systemd/system/${SERVICE_NAME}.service.d contient ${fs.readdirSync(dropIns).join(", ")}, qui complète(nt) l'unité.`);
    }
    must(host, "systemctl", ["daemon-reload"]);
    must(host, "systemctl", ["enable", SERVICE_NAME]);
    must(host, "systemctl", ["restart", SERVICE_NAME]);
    if (!(await host.waitHealthy(port, HEALTH_TIMEOUT_MS))) fail(`le serveur ne répond pas sur 127.0.0.1:${port} : voyez « journalctl -u ${SERVICE_NAME} -n 50 ».`);
    host.say(`  Démarré, répond sur 127.0.0.1:${port}.`);

    if (nginx && !servedBy) {
      step("nginx");
      const site = sys(host, `/etc/nginx/sites-available/${SERVICE_NAME}`);
      const enabled = sys(host, `/etc/nginx/sites-enabled/${SERVICE_NAME}`);
      const existingSite = readIfExists(site);
      if (existingSite === undefined) {
        fs.mkdirSync(path.dirname(site), { recursive: true });
        fs.writeFileSync(site, renderNginxSite(appUrl.hostname, port));
        host.say(`  /etc/nginx/sites-available/${SERVICE_NAME}`);
      } else host.say(`  /etc/nginx/sites-available/${SERVICE_NAME} existe : gardé tel quel.`);
      if (!fs.existsSync(enabled)) must(host, "ln", ["-s", `/etc/nginx/sites-available/${SERVICE_NAME}`, enabled]);
      must(host, "nginx", ["-t"]);
      must(host, "systemctl", ["reload", "nginx"]);
      host.say("  Site activé, nginx rechargé.");
      if (certbot) {
        must(host, "certbot", ["--nginx", "-d", appUrl.hostname, "--non-interactive", "--agree-tos", "-m", certbotEmail!, "--redirect", "--keep-until-expiring"], { inherit: true });
        host.say(`  Certificat en place pour ${appUrl.hostname}.`);
      }
    }

    step("Terminé");
    host.say(`  Interface : ${appUrl.origin}`);
    host.say(`  Données : ${dataDir} ; service : systemctl status ${SERVICE_NAME}`);
    host.say("  Reste à faire dans l'interface : le token GitHub du tracker (Réglages › GitHub), puis le token Claude pour les corrections par Claude.");
    if (account) host.say(`  Protégez le compte par un second facteur : mcp-dependabot-tracker user totp ${account.email}`);
    return 0;
  } catch (err: any) {
    process.stderr.write(`Installation interrompue : ${err?.message ?? err}\n`);
    return 1;
  }
}
