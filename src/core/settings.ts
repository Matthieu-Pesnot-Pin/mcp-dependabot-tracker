import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DEFAULT_SETTINGS, SettingsSchema, type GitHubTokenView, type SaveSettingsBody, type Settings, type SettingsView } from "../../shared/schemas/settings.schema.js";
import { TrackerError } from "./errors.js";
import type { TokenCheck } from "./github.js";
import { organizerUrl, type OrganizerConnection, type OrganizerSpace } from "./organizer.js";
import { decryptSecret, encryptSecret, isEncrypted } from "./vault.js";

/**
 * Réglages du tracker, dans `<données>/settings.json`, lisible par le seul
 * compte du serveur : ils portent le token GitHub du tracker, le token de
 * déploiement, le token de l'organizer et celui de Claude, chiffrés avec
 * VAULT_KEY dans le fichier, que la GUI ne reçoit jamais en entier.
 */

/** Durée de validité d'un token créé par `claude setup-token`. */
const CLAUDE_TOKEN_VALIDITY_MS = 365 * 24 * 3600_000;

/** Vérifications faites à l'enregistrement : remplacées dans les tests. */
export interface SettingsChecks {
  organizer: (connection: OrganizerConnection) => Promise<OrganizerSpace>;
  claudeToken: (token: string) => Promise<void>;
  /** Vérifie un token auprès de GitHub et relève son compte et son expiration. */
  githubToken: (token: string) => Promise<TokenCheck>;
}

function settingsPath(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}

/** Contenu de `settings.json` tel qu'il est écrit, tokens compris ; null sans fichier. */
function readSettingsFile(dataDir: string): Settings | null {
  const file = settingsPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const parsed = SettingsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new TrackerError(`${file} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/** Applique `fn` à chaque token des réglages, null laissé tel quel. */
function mapTokens(settings: Settings, fn: (token: string) => string): Settings {
  const map = (token: string | null) => (token === null ? null : fn(token));
  return {
    ...settings,
    organizer: { ...settings.organizer, token: map(settings.organizer.token) },
    claude: { ...settings.claude, token: map(settings.claude.token) },
    github: { ...settings.github, token: map(settings.github.token) },
    deploy: { ...settings.deploy, token: map(settings.deploy.token) },
  };
}

/** Réglages, tokens déchiffrés avec `vaultKey` ; un token que la clé ne déchiffre pas lève une erreur. */
export function readSettings(dataDir: string, vaultKey: Buffer): Settings {
  const stored = readSettingsFile(dataDir);
  if (stored === null) return DEFAULT_SETTINGS;
  return mapTokens(stored, (token) => {
    try {
      return decryptSecret(token, vaultKey);
    } catch (err: any) {
      throw new TrackerError(`A token of ${settingsPath(dataDir)} cannot be read: ${err.message}`);
    }
  });
}

/**
 * Chiffre avec `vaultKey` les tokens de `settings.json` écrits en clair par une
 * version antérieure ; rend vrai si le fichier a été réécrit.
 */
export function encryptStoredTokens(dataDir: string, vaultKey: Buffer): boolean {
  const stored = readSettingsFile(dataDir);
  if (stored === null) return false;
  const tokens = [stored.organizer.token, stored.claude.token, stored.github.token, stored.deploy.token].filter((token): token is string => token !== null);
  if (tokens.every(isEncrypted)) return false;
  writeSettingsFile(dataDir, mapTokens(stored, (token) => (isEncrypted(token) ? token : encryptSecret(token, vaultKey))));
  return true;
}

function writeSettings(dataDir: string, vaultKey: Buffer, settings: Settings): void {
  writeSettingsFile(dataDir, mapTokens(settings, (token) => encryptSecret(token, vaultKey)));
}

function writeSettingsFile(dataDir: string, settings: Settings): void {
  const file = settingsPath(dataDir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(SettingsSchema.parse(settings), null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Connexion à l'organizer, null tant que l'adresse ou le token manque. */
export function organizerConnection(settings: Settings): OrganizerConnection | null {
  const { url, token } = settings.organizer;
  return url && token ? { url, token } : null;
}

/** Résultat de la reprise de GITHUB_TOKEN au démarrage. */
export type EnvTokenAdoption = { status: "none" } | { status: "ignored" } | { status: "adopted"; warning: string | null };

/**
 * Reprend dans les réglages le GITHUB_TOKEN de l'environnement tant que les
 * réglages n'ont pas de token du tracker : il y est vérifié auprès de GitHub
 * (un refus est rendu en avertissement, le token est repris quand même) et
 * chiffré. Avec un token déjà réglé, la variable est ignorée.
 */
export async function adoptEnvGitHubToken(dataDir: string, vaultKey: Buffer, envToken: string | undefined, checks: SettingsChecks): Promise<EnvTokenAdoption> {
  const token = envToken?.trim();
  if (!token) return { status: "none" };
  const current = readSettings(dataDir, vaultKey);
  if (current.github.token !== null) return { status: "ignored" };
  let check: TokenCheck | null = null;
  let warning: string | null = null;
  try {
    check = await checks.githubToken(token);
  } catch (err: any) {
    warning = err?.message ?? String(err);
  }
  writeSettings(dataDir, vaultKey, { ...current, github: { token, savedAt: new Date().toISOString(), login: check?.login ?? null, expiresAt: check?.expiresAt ?? null } });
  return { status: "adopted", warning };
}

/** Token GitHub du tracker, null sans token enregistré. */
export function githubToken(settings: Settings): string | null {
  return settings.github.token;
}

/** Token GitHub transmis aux scripts de déploiement, null sans token enregistré. */
export function deployToken(settings: Settings): string | null {
  return settings.deploy.token;
}

/** Vrai quand l'organizer (connexion testée) et Claude sont configurés. */
export function analysisReady(settings: Settings): boolean {
  return organizerConnection(settings) !== null && settings.organizer.space !== null && settings.claude.token !== null;
}

function tokenHint(token: string | null): string | null {
  return token === null ? null : token.slice(-4);
}

function tokenView({ token, savedAt, login, expiresAt }: Settings["github"]): GitHubTokenView {
  return { tokenHint: tokenHint(token), savedAt, login, expiresAt };
}

/** Token GitHub vérifié, avec son compte et son expiration, prêt à enregistrer. */
async function checkedGitHubToken(token: string, checks: SettingsChecks): Promise<Settings["github"]> {
  const { login, expiresAt } = await checks.githubToken(token);
  return { token, savedAt: new Date().toISOString(), login, expiresAt };
}

export function settingsView(settings: Settings): SettingsView {
  const { savedAt } = settings.claude;
  return {
    organizer: { url: settings.organizer.url, tokenHint: tokenHint(settings.organizer.token), space: settings.organizer.space, owner: settings.organizer.owner },
    claude: {
      tokenHint: tokenHint(settings.claude.token),
      savedAt,
      expiresAt: savedAt === null ? null : new Date(Date.parse(savedAt) + CLAUDE_TOKEN_VALIDITY_MS).toISOString(),
    },
    analysis: settings.analysis,
    ready: analysisReady(settings),
    github: tokenView(settings.github),
    deploy: tokenView(settings.deploy),
  };
}

/** Espace et propriétaire relevés par un test de la connexion, ou rien sans connexion. */
async function checkedOrganizer(organizer: Settings["organizer"], checks: SettingsChecks): Promise<Settings["organizer"]> {
  if (!organizer.url || !organizer.token) return { ...organizer, space: null, owner: null };
  const found = await checks.organizer({ url: organizer.url, token: organizer.token });
  return { ...organizer, space: found.space.name, owner: found.owner.name };
}

/**
 * Enregistre les réglages de la GUI. Une connexion à l'organizer modifiée est
 * testée, un nouveau token Claude ou GitHub vérifié : un échec refuse tout
 * l'enregistrement.
 */
export async function saveSettings(dataDir: string, vaultKey: Buffer, body: SaveSettingsBody, checks: SettingsChecks): Promise<SettingsView> {
  const current = readSettings(dataDir, vaultKey);
  const url = body.organizerUrl === "" ? null : organizerUrl(body.organizerUrl);
  const token = body.organizerToken ?? current.organizer.token;
  const organizerChanged = url !== current.organizer.url || token !== current.organizer.token;
  const organizer = organizerChanged ? await checkedOrganizer({ ...current.organizer, url, token }, checks) : current.organizer;

  let claude = current.claude;
  if (body.claudeToken !== undefined) {
    await checks.claudeToken(body.claudeToken);
    claude = { token: body.claudeToken, savedAt: new Date().toISOString() };
  }

  const github = body.githubToken === undefined ? current.github : await checkedGitHubToken(body.githubToken, checks);

  let deploy = current.deploy;
  if (body.deployToken === null) {
    deploy = DEFAULT_SETTINGS.deploy;
  } else if (body.deployToken !== undefined) {
    deploy = await checkedGitHubToken(body.deployToken, checks);
  }

  const next: Settings = { organizer, claude, analysis: body.analysis, github, deploy };
  writeSettings(dataDir, vaultKey, next);
  return settingsView(next);
}

/** Teste la connexion enregistrée à l'organizer et relève son espace et son propriétaire. */
export async function testOrganizer(dataDir: string, vaultKey: Buffer, checks: SettingsChecks): Promise<SettingsView> {
  const current = readSettings(dataDir, vaultKey);
  if (!organizerConnection(current)) throw new TrackerError("Set the organizer address and token first.");
  const next = { ...current, organizer: await checkedOrganizer(current.organizer, checks) };
  writeSettings(dataDir, vaultKey, next);
  return settingsView(next);
}
