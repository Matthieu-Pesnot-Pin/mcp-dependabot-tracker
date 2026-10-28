/** Forme de réponse attendue par le SDK MCP pour un appel d'outil. */
export interface ToolResult {
  // Signature d'index exigée par le type de retour du SDK MCP.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Arguments d'un outil. */
export type Args = Record<string, unknown> | undefined;

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

/** Lit un argument texte obligatoire, rogné ; lève une erreur s'il est absent ou vide. */
export function requireString(args: Args, field: string): string {
  const value = args?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

/** Lit un argument texte facultatif, rogné ; `undefined` s'il est absent, erreur s'il est vide ou d'un autre type. */
export function optionalString(args: Args, field: string): string | undefined {
  if (args?.[field] === undefined) return undefined;
  return requireString(args, field);
}

/** Lit un booléen facultatif ; `fallback` s'il est absent. */
export function optionalBoolean(args: Args, field: string, fallback: boolean): boolean {
  const value = args?.[field];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`"${field}" must be a boolean (got ${JSON.stringify(value)}).`);
  return value;
}

/** Lève une erreur si `args` contient des champs hors de `allowed` : une faute de frappe ne passe pas inaperçue. */
export function rejectUnknownFields(args: Args, allowed: readonly string[]): void {
  if (!args) return;
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown field(s): ${unknown.join(", ")}. Accepted fields: ${allowed.join(", ") || "none"}.`);
  }
}
