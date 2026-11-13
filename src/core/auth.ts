import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

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

/** Base SQLite des comptes et des sessions, dans le répertoire des données. */
function openDatabase(dataDir: string): BetterAuthOptions["database"] {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "auth.sqlite"));
  db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Instance Better Auth : comptes e-mail + mot de passe créés en ligne de
 * commande (inscription fermée), sessions en base, limitation de débit active.
 */
export function createAuth(dataDir: string, env: AuthEnv) {
  return betterAuth({
    appName: "Dependabot Tracker",
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
  return { email: user.email, name: user.name, createdAt: user.createdAt };
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
  return users.map((user) => ({ email: user.email, name: user.name, createdAt: user.createdAt }));
}

/** Nombre de comptes. */
export async function countUsers(auth: Auth): Promise<number> {
  return (await auth.$context).internalAdapter.countTotalUsers();
}
