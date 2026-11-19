import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUDIT_SCOPES, MANAGERS, type AuditScope, type ManagerId } from "../shared/schemas/model.schema.js";
import { tail } from "./core/commands.js";
import type { ContainerRuntime, Workspace } from "./core/containers.js";
import { managerOf } from "./core/managers/index.js";
import { runManager, type ManagerContext, type ManagerTool, type PackageManager } from "./core/managers/types.js";
import { APP_VERSION } from "./version.js";
import { errorResult, type Args } from "./tools/types.js";

/**
 * Serveur MCP des commandes des gestionnaires de paquets des corrections par
 * Claude, lancé par Claude Code avec `node package-tools.js --root <clone>
 * --cache <cache> --scope <périmètre> --managers <npm,pnpm,composer>
 * --runtime <commande Podman en JSON>` : il sert les outils des gestionnaires
 * cités ; chacun lance une commande fixe du gestionnaire dans un projet du
 * clone, dans un conteneur jetable, et rend son code de sortie et la fin de
 * ses sorties.
 */

/** Lignes de sortie rendues à Claude. */
const OUTPUT_LINES = 150;

/** Taille maximale de la sortie rendue à Claude. */
const OUTPUT_CHARS = 20_000;

const PROJECT_PROPERTY = {
  type: "string",
  description: 'Folder of the project (where its manifest and lockfile are), relative to the repository root; "" for the root.',
};

/** Outils des gestionnaires `managers`, chacun avec son gestionnaire. */
export function toolsOf(managers: ManagerId[]): { manager: PackageManager; tool: ManagerTool }[] {
  return managers.flatMap((id) => managerOf(id).tools.map((tool) => ({ manager: managerOf(id), tool })));
}

/** Projet visé : `""` désigne la racine du clone. */
function project(args: Args): string {
  const value = args?.project;
  if (typeof value !== "string") throw new Error('"project" is required: the folder of the project, "" for the root.');
  return value.trim();
}

/** Lance l'outil `name` et décrit le résultat : commande, code de sortie, fin des sorties. */
export async function callPackageTool(ctx: ManagerContext, managers: ManagerId[], name: string, args: Args): Promise<CallToolResult> {
  const found = toolsOf(managers).find(({ tool }) => tool.name === name);
  if (!found) throw new Error(`Unknown tool: ${name}`);
  const managerArgs = found.tool.args(args, ctx.scope);
  const folder = project(args);
  const command = found.manager.command(ctx, folder, managerArgs).command;
  const result = await runManager(found.manager, ctx, folder, managerArgs);
  const output = tail(`${result.stdout}\n${result.stderr}`, OUTPUT_LINES);
  const text = [`$ ${command.join(" ")}  (in ${folder || "."}, exit code ${result.code})`, output.length > OUTPUT_CHARS ? `…${output.slice(-OUTPUT_CHARS)}` : output].join("\n");
  return { content: [{ type: "text", text }], isError: result.code !== 0 };
}

/** Lit `--root`, `--cache`, `--scope`, `--managers` et `--runtime`, puis sert les outils sur stdio. */
export async function servePackageTools(argv: string[]): Promise<void> {
  const option = (flag: string) => {
    const index = argv.indexOf(flag);
    const value = index === -1 ? undefined : argv[index + 1];
    if (!value) throw new Error(`${flag} is required.`);
    return value;
  };
  const workspace: Workspace = { root: option("--root"), cache: option("--cache") };
  const scope = option("--scope") as AuditScope;
  if (!AUDIT_SCOPES.includes(scope)) throw new Error(`--scope must be one of ${AUDIT_SCOPES.join(", ")}.`);
  const managers = option("--managers").split(",") as ManagerId[];
  if (managers.some((id) => !MANAGERS.includes(id))) throw new Error(`--managers must list some of ${MANAGERS.join(", ")}.`);
  const command = JSON.parse(option("--runtime"));
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) throw new Error("--runtime must be a JSON array of strings.");
  const ctx: ManagerContext = { runtime: { command } satisfies ContainerRuntime, workspace, scope, log: () => {} };

  const tools = toolsOf(managers).map(({ tool }) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY, ...tool.properties }, required: ["project", ...tool.required] },
  }));
  const server = new Server({ name: "mcp-dependabot-tracker-packages", version: APP_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      return await callPackageTool(ctx, managers, request.params.name, request.params.arguments);
    } catch (err: any) {
      return errorResult(err?.message ?? String(err));
    }
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await servePackageTools(process.argv.slice(2));
}
