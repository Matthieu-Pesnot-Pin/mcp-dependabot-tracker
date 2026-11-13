import { z } from "zod";

/**
 * Token d'accès d'un agent, enregistré dans `<données>/agent-tokens.json` :
 * `hash` est l'empreinte SHA-256 du token, qui n'est jamais conservé en clair ;
 * `hint` ses quatre derniers caractères ; `lastUsedAt` la date de sa dernière
 * utilisation, null s'il n'a jamais servi.
 */
export const AgentTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  hint: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export type AgentToken = z.infer<typeof AgentTokenSchema>;

export const AgentTokensFileSchema = z.object({ tokens: z.array(AgentTokenSchema) });

export type AgentTokensFile = z.infer<typeof AgentTokensFileSchema>;

/** Token tel que la GUI le reçoit : sans son empreinte. */
export type AgentTokenView = Omit<AgentToken, "hash">;

/** Tokens d'agent, du plus récent au plus ancien. */
export interface AgentTokensResponse {
  tokens: AgentTokenView[];
}

/** Corps de `POST /api/agent-tokens`. */
export const CreateAgentTokenBodySchema = z.object({ name: z.string().trim().min(1).max(60) });

export type CreateAgentTokenBody = z.infer<typeof CreateAgentTokenBodySchema>;

/**
 * Token qui vient d'être créé : `secret` est le token en clair, rendu une seule
 * fois ; `setupCommand` la commande qui déclare le mode MCP avec ce token.
 */
export interface CreatedAgentTokenResponse {
  token: AgentTokenView;
  secret: string;
  setupCommand: string;
}
