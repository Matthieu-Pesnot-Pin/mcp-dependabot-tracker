import crypto from "crypto";
import fs from "fs";
import path from "path";
import { AgentTokensFileSchema, type AgentToken, type AgentTokensFile, type AgentTokenView } from "../../shared/schemas/agent-token.schema.js";
import { NotFoundError, TrackerError } from "./errors.js";

/**
 * Tokens d'accès des agents, dans `<données>/agent-tokens.json`, lisible par le
 * seul compte du serveur. Un token se présente au serveur par l'en-tête
 * `Authorization: Bearer <token>` ; seule son empreinte est enregistrée.
 */

/** Préfixe qui rend un token d'agent reconnaissable. */
const TOKEN_PREFIX = "dtk_";

/** Écart en deçà duquel une nouvelle utilisation ne réécrit pas `lastUsedAt`. */
const LAST_USED_RESOLUTION_MS = 60_000;

function tokensPath(dataDir: string): string {
  return path.join(dataDir, "agent-tokens.json");
}

function hashOf(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf-8").digest("hex");
}

function view({ hash: _hash, ...token }: AgentToken): AgentTokenView {
  return token;
}

function readTokens(dataDir: string): AgentTokensFile {
  const file = tokensPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return { tokens: [] };
    throw err;
  }
  const parsed = AgentTokensFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new TrackerError(`${file} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function writeTokens(dataDir: string, file: AgentTokensFile): void {
  const target = tokensPath(dataDir);
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(AgentTokensFileSchema.parse(file), null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Tokens d'agent, du plus récent au plus ancien. */
export function listAgentTokens(dataDir: string): AgentTokenView[] {
  return readTokens(dataDir)
    .tokens.map(view)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Crée un token nommé `name` ; rend le token en clair, qui n'est plus jamais lisible ensuite. */
export function createAgentToken(dataDir: string, name: string): { token: AgentTokenView; secret: string } {
  const secret = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const token: AgentToken = {
    id: crypto.randomBytes(6).toString("hex"),
    name: name.trim(),
    hash: hashOf(secret),
    hint: secret.slice(-4),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const file = readTokens(dataDir);
  writeTokens(dataDir, { tokens: [...file.tokens, token] });
  return { token: view(token), secret };
}

/** Révoque un token : il cesse aussitôt d'ouvrir l'accès. */
export function revokeAgentToken(dataDir: string, id: string): void {
  const file = readTokens(dataDir);
  if (!file.tokens.some((token) => token.id === id)) throw new NotFoundError(`Agent token "${id}" does not exist.`);
  writeTokens(dataDir, { tokens: file.tokens.filter((token) => token.id !== id) });
}

/**
 * Token d'agent correspondant à `secret`, null s'il n'existe pas ou a été
 * révoqué. Sa date de dernière utilisation est mise à jour.
 */
export function authenticateAgent(dataDir: string, secret: string): AgentTokenView | null {
  const file = readTokens(dataDir);
  const hash = hashOf(secret);
  const token = file.tokens.find((candidate) => crypto.timingSafeEqual(Buffer.from(candidate.hash, "hex"), Buffer.from(hash, "hex")));
  if (!token) return null;
  const now = new Date();
  if (token.lastUsedAt !== null && now.getTime() - Date.parse(token.lastUsedAt) < LAST_USED_RESOLUTION_MS) return view(token);
  const used = { ...token, lastUsedAt: now.toISOString() };
  writeTokens(dataDir, { tokens: file.tokens.map((candidate) => (candidate.id === token.id ? used : candidate)) });
  return view(used);
}
