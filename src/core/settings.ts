import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DEFAULT_SETTINGS, SettingsSchema, type SaveSettingsBody, type Settings, type SettingsView } from "../../shared/schemas/settings.schema.js";
import { TrackerError } from "./errors.js";
import { organizerUrl, type OrganizerConnection, type OrganizerSpace } from "./organizer.js";
import { decryptSecret, encryptSecret, isEncrypted } from "./vault.js";

/**
 * Réglages des corrections par Claude, dans `<données>/settings.json`, lisible par
 * le seul compte du serveur : ils portent le token de l'organizer et celui de
 * Claude, chiffrés avec VAULT_KEY dans le fichier, que la GUI ne reçoit jamais
 * en entier.
 */

/** Durée de validité d'un token créé par `claude setup-token`. */
const CLAUDE_TOKEN_VALIDITY_MS = 365 * 24 * 3600_000;

/** Vérifications faites à l'enregistrement : remplacées dans les tests. */
export interface SettingsChecks {
  organizer: (connection: OrganizerConnection) => Promise<OrganizerSpace>;
  claudeToken: (token: string) => Promise<void>;
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
  return { ...settings, organizer: { ...settings.organizer, token: map(settings.organizer.token) }, claude: { ...settings.claude, token: map(settings.claude.token) } };
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
  const tokens = [stored.organizer.token, stored.claude.token].filter((token): token is string => token !== null);
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

/** Vrai quand l'organizer (connexion testée) et Claude sont configurés. */
export function analysisReady(settings: Settings): boolean {
  return organizerConnection(settings) !== null && settings.organizer.space !== null && settings.claude.token !== null;
}

function tokenHint(token: string | null): string | null {
  return token === null ? null : token.slice(-4);
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
 * testée, un nouveau token Claude vérifié : un échec refuse tout
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

  const next: Settings = { organizer, claude, analysis: body.analysis };
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
