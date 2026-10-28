import { z } from "zod";

/**
 * Nature d'une erreur renvoyée par le maître à une requête du GUI worker, qui
 * la traduit en code HTTP : invalid → 400, not_found → 404, conflict → 409,
 * internal → 500.
 */
export const IPC_ERROR_KINDS = ["invalid", "not_found", "conflict", "internal"] as const;

export type IpcErrorKind = (typeof IPC_ERROR_KINDS)[number];

/** Message échangé entre le processus maître MCP et le GUI worker. */
export const IPCMessageSchema = z.object({
  type: z.string(),
  correlationId: z.string().optional(),
  data: z.any().optional(),
  error: z.string().optional(),
  errorKind: z.enum(IPC_ERROR_KINDS).optional(),
  timestamp: z.string(),
});

export type IPCMessage = z.infer<typeof IPCMessageSchema>;

/** Requêtes du GUI worker au maître ; chacune reçoit une réponse de même `correlationId`. */
export const GUI_REQUEST_TYPES = [
  "GET_CONFIG",
  "LIST_REPOS",
  "SYNC_REPOS",
  "LIST_ADDABLE_REPOS",
  "GET_REPO",
  "ADD_REPO",
  "REMOVE_REPO",
  "SET_RIGHTS",
  "LIST_BRANCHES",
  "SET_BRANCH",
  "SET_CATEGORY",
  "MARK_ALERT_HANDLED",
  "UNMARK_ALERT_HANDLED",
  "LIST_CATEGORIES",
  "CREATE_CATEGORY",
  "RENAME_CATEGORY",
  "DELETE_CATEGORY",
  "START_FIX",
  "GET_OPERATION",
  "DECIDE_FORCE",
  "PUSH_OPERATION",
  "CANCEL_OPERATION",
] as const;

export type GuiRequestType = (typeof GUI_REQUEST_TYPES)[number];
