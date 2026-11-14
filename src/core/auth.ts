import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { twoFactor } from "better-auth/plugins/two-factor";

import { ConflictError, NotFoundError, TrackerError } from "./errors.js";
import type { AuthEnv } from "./server-config.js";

/**
 * En-tête où le serveur écrit l'adresse du client, calculée depuis la socket
 * (et X-Forwarded-For quand la socket est un proxy de confiance) ; la valeur
 * reçue du client est toujours écrasée. Le limiteur de débit le lit.
 */
export const CLIENT_IP_HEADER = "x-tracker-client-ip";

/** Chemin des routes de Better Auth. */
export const AUTH_BASE_PATH = "/api/auth";

const MIN_PASSWORD_LENGTH = 12;

const APP_NAME = "Dependabot Tracker";

/** Table des secrets TOTP et des codes de secours du plugin de double authentification. */
const TWO_FACTOR_TABLE = "twoFactor";

const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const BACKUP_CODE_COUNT = 10;

/** Base SQLite des comptes et des sessions, dans le répertoire des données. */
function openDatabase(dataDir: string): BetterAuthOptions["database"] {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "auth.sqlite"));
  db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Instance Better Auth : comptes e-mail + mot de passe créés en ligne de
 * commande (inscription fermée), sessions en base, limitation de débit active,
 * double authentification par code TOTP ou code de secours pour les comptes qui
 * l'ont activée.
 */
export function createAuth(dataDir: string, env: AuthEnv) {
  return betterAuth({
    appName: APP_NAME,
    baseURL: env.appUrl,
    basePath: AUTH_BASE_PATH,
    secret: env.authSecret,
    trustedOrigins: [env.appUrl],
    database: openDatabase(dataDir),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
      },
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: [CLIENT_IP_HEADER],
        trustedProxies: env.trustedProxies,
      },
    },
    plugins: [twoFactor({ issuer: APP_NAME, totpOptions: { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS } })],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Crée ou complète les tables de Better Auth. */
export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** Nouveau secret de session : 48 octets aléatoires en base64. */
export function generateAuthSecret(): string {
  return crypto.randomBytes(48).toString("base64");
}

export interface UserSummary {
  email: string;
  name: string;
  createdAt: Date;
  /** La double authentification est activée. */
  twoFactor: boolean;
}

function summaryOf(user: { email: string; name: string; createdAt: Date; twoFactorEnabled?: boolean | null }): UserSummary {
  return { email: user.email, name: user.name, createdAt: user.createdAt, twoFactor: user.twoFactorEnabled === true };
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new TrackerError(`"${raw}" is not an e-mail address.`);
  return email;
}

async function checkedHash(auth: Auth, password: string): Promise<string> {
  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (password.length < minPasswordLength) throw new TrackerError(`The password is too short: at least ${minPasswordLength} characters.`);
  if (password.length > maxPasswordLength) throw new TrackerError(`The password is too long: at most ${maxPasswordLength} characters.`);
  return ctx.password.hash(password);
}

async function requireUser(auth: Auth, email: string) {
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(normalizeEmail(email));
  if (!found) throw new NotFoundError(`No account uses ${email}.`);
  return found.user;
}

/** Crée un compte e-mail + mot de passe. */
export async function addUser(auth: Auth, input: { email: string; name: string; password: string }): Promise<UserSummary> {
  const ctx = await auth.$context;
  const email = normalizeEmail(input.email);
  if (await ctx.internalAdapter.findUserByEmail(email)) throw new ConflictError(`An account already uses ${email}.`);
  const hash = await checkedHash(auth, input.password);
  const user = await ctx.internalAdapter.createUser({ email, name: input.name.trim() || email, emailVerified: true }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  return summaryOf(user);
}

/** Remplace le mot de passe d'un compte et ferme toutes ses sessions. */
export async function setUserPassword(auth: Auth, email: string, password: string): Promise<void> {
  const ctx = await auth.$context;
  const user = await requireUser(auth, email);
  const hash = await checkedHash(auth, password);
  await ctx.internalAdapter.updatePassword(user.id, hash);
  await ctx.internalAdapter.deleteUserSessions(user.id);
}

/** Supprime un compte, ses sessions et son mot de passe. */
export async function removeUser(auth: Auth, email: string): Promise<void> {
  const ctx = await auth.$context;
  const user = await requireUser(auth, email);
  await ctx.internalAdapter.deleteUser(user.id);
}

/** Comptes existants, du plus ancien au plus récent. */
export async function listUsers(auth: Auth): Promise<UserSummary[]> {
  const ctx = await auth.$context;
  const users = await ctx.internalAdapter.listUsers(undefined, undefined, { field: "createdAt", direction: "asc" });
  return users.map(summaryOf);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encodage base32 (RFC 4648) sans remplissage, celui des clés des applications d'authentification. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) encoded += BASE32_ALPHABET[parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return encoded;
}

/** Double authentification préparée pour un compte, pas encore enregistrée. */
export interface TotpEnrollment {
  /** Secret TOTP, tel que le plugin l'enregistre. */
  secret: string;
  /** Clé à saisir dans l'application d'authentification : le secret en base32. */
  key: string;
  /** Adresse `otpauth://` de la clé, pour un QR code ou un gestionnaire de mots de passe. */
  uri: string;
  /** Codes de secours, chacun utilisable une fois à la place du code de l'application. */
  backupCodes: string[];
}

/** Prépare un secret TOTP et des codes de secours pour le compte `email`, sans rien enregistrer. */
export async function prepareTotp(auth: Auth, email: string): Promise<TotpEnrollment> {
  const user = await requireUser(auth, email);
  const secret = generateRandomString(32);
  const key = base32Encode(new TextEncoder().encode(secret));
  const parameters = new URLSearchParams({ secret: key, issuer: APP_NAME, digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => generateRandomString(10, "a-z", "0-9", "A-Z")).map((code) => `${code.slice(0, 5)}-${code.slice(5)}`);
  return { secret, key, uri: `otpauth://totp/${encodeURIComponent(APP_NAME)}:${encodeURIComponent(user.email)}?${parameters}`, backupCodes };
}

/** Code TOTP du moment pour `secret`. */
export async function currentTotpCode(auth: Auth, secret: string): Promise<string> {
  return (await auth.api.generateTOTP({ body: { secret } })).code;
}

/**
 * Active la double authentification du compte avec `enrollment`, à la place de
 * celle qu'il avait, et ferme toutes ses sessions.
 */
export async function enableTotp(auth: Auth, email: string, enrollment: TotpEnrollment): Promise<void> {
  const ctx = await auth.$context;
  const user = await requireUser(auth, email);
  const data = {
    secret: await symmetricEncrypt({ key: ctx.secretConfig, data: enrollment.secret }),
    backupCodes: await symmetricEncrypt({ key: ctx.secretConfig, data: JSON.stringify(enrollment.backupCodes) }),
    verified: true,
    failedVerificationCount: 0,
    lockedUntil: null,
  };
  const where = [{ field: "userId", value: user.id }];
  const existing = await ctx.adapter.findOne({ model: TWO_FACTOR_TABLE, where });
  if (existing) await ctx.adapter.update({ model: TWO_FACTOR_TABLE, where, update: data });
  else await ctx.adapter.create({ model: TWO_FACTOR_TABLE, data: { ...data, userId: user.id } });
  await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
  await ctx.internalAdapter.deleteUserSessions(user.id);
}

/** Retire la double authentification du compte : son secret et ses codes de secours sont effacés. */
export async function disableTotp(auth: Auth, email: string): Promise<void> {
  const ctx = await auth.$context;
  const user = await requireUser(auth, email);
  await ctx.adapter.delete({ model: TWO_FACTOR_TABLE, where: [{ field: "userId", value: user.id }] });
  await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: false });
}
