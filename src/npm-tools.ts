import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUDIT_SCOPES, type AuditScope } from "../shared/schemas/model.schema.js";
import { runSandboxedNpm, type NpmSandbox } from "./core/npm-sandbox.js";
import { tail } from "./core/commands.js";
import { APP_VERSION } from "./version.js";
import { errorResult, requireString, rejectUnknownFields, type Args } from "./tools/types.js";

/**
 * Serveur MCP des commandes npm des corrections par Claude, lancé par Claude
 * Code avec `node npm-tools.js --root <clone> --cache <cache> --scope <périmètre>` :
 * chaque outil lance une commande npm fixe dans un projet du clone, à travers
 * `runSandboxedNpm`, et rend son code de sortie et la fin de ses sorties.
 */

/** Lignes de sortie rendues à Claude. */
const OUTPUT_LINES = 150;

/** Taille maximale de la sortie rendue à Claude. */
const OUTPUT_CHARS = 20_000;

/** Nom de paquet, spécification de version ou nom de script : pas d'option, pas d'espace. */
const NAME = /^[A-Za-z0-9@/._^~<>=*:+-]+$/;

const PROJECT_PROPERTY = {
  type: "string",
  description: 'Folder of the package.json, relative to the repository root; "" for the root.',
};

const TOOLS = [
  {
    name: "npm_install_lockfile",
    description:
      "Run npm install --package-lock-only --ignore-scripts in a project: updates package-lock.json (and package.json for the packages given) without installing node_modules. Use it after changing package.json or its overrides.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: PROJECT_PROPERTY,
        packages: { type: "array", items: { type: "string" }, description: "Packages to add or upgrade, e.g. mermaid@12.0.1 (optional)." },
      },
      required: ["project"],
    },
  },
  { name: "npm_audit", description: "Run npm audit in a project, with the scope of the operation.", inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY }, required: ["project"] } },
  { name: "npm_ci", description: "Run npm ci in a project: installs node_modules from package-lock.json, install scripts included.", inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY }, required: ["project"] } },
  { name: "npm_test", description: "Run npm test in a project.", inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY }, required: ["project"] } },
  {
    name: "npm_run",
    description: "Run a script of package.json in a project (npm run <script>).",
    inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY, script: { type: "string", description: "Name of the script." } }, required: ["project", "script"] },
  },
  {
    name: "npm_ls",
    description: "Show where a package is installed in the dependency tree of a project (npm ls <package> --all).",
    inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY, package: { type: "string", description: "Name of the package." } }, required: ["project", "package"] },
  },
  { name: "tsc", description: "Type-check a project with its own TypeScript (npm exec --no -- tsc --noEmit).", inputSchema: { type: "object" as const, properties: { project: PROJECT_PROPERTY }, required: ["project"] } },
];

/** Lit un nom de paquet ou de script ; lève une erreur s'il contient autre chose. */
function name(value: string, field: string): string {
  if (!NAME.test(value) || value.startsWith("-")) throw new Error(`"${field}" must be a package or script name (got ${JSON.stringify(value)}).`);
  return value;
}

/** Projet visé : `""` désigne la racine du clone. */
function project(args: Args): string {
  const value = args?.project;
  if (typeof value !== "string") throw new Error('"project" is required: the folder of the package.json, "" for the root.');
  return value.trim();
}

/** Arguments npm de l'outil appelé. */
export function npmArgs(tool: string, args: Args, scope: AuditScope): string[] {
  switch (tool) {
    case "npm_install_lockfile": {
      rejectUnknownFields(args, ["project", "packages"]);
      const packages = args?.packages ?? [];
      if (!Array.isArray(packages) || packages.some((item) => typeof item !== "string")) throw new Error('"packages" must be a list of package names.');
      return ["install", "--package-lock-only", "--ignore-scripts", ...packages.map((item: string) => name(item.trim(), "packages"))];
    }
    case "npm_audit":
      rejectUnknownFields(args, ["project"]);
      return scope === "production" ? ["audit", "--omit=dev"] : ["audit"];
    case "npm_ci":
      rejectUnknownFields(args, ["project"]);
      return ["ci"];
    case "npm_test":
      rejectUnknownFields(args, ["project"]);
      return ["test"];
    case "npm_run":
      rejectUnknownFields(args, ["project", "script"]);
      return ["run", name(requireString(args, "script"), "script")];
    case "npm_ls":
      rejectUnknownFields(args, ["project", "package"]);
      return ["ls", name(requireString(args, "package"), "package"), "--all"];
    case "tsc":
      rejectUnknownFields(args, ["project"]);
      return ["exec", "--no", "--", "tsc", "--noEmit"];
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/** Lance l'outil et décrit le résultat : commande, code de sortie, fin des sorties. */
export async function callNpmTool(sandbox: NpmSandbox, scope: AuditScope, tool: string, args: Args): Promise<CallToolResult> {
  const npm = npmArgs(tool, args, scope);
  const folder = project(args);
  const result = await runSandboxedNpm(sandbox, folder, npm);
  const output = tail(`${result.stdout}\n${result.stderr}`, OUTPUT_LINES);
  const text = [`$ npm ${npm.join(" ")}  (in ${folder || "."}, exit code ${result.code})`, output.length > OUTPUT_CHARS ? `…${output.slice(-OUTPUT_CHARS)}` : output].join("\n");
  return { content: [{ type: "text", text }], isError: result.code !== 0 };
}

/** Lit `--root`, `--cache` et `--scope`, puis sert les outils sur stdio. */
export async function serveNpmTools(argv: string[]): Promise<void> {
  const option = (flag: string) => {
    const index = argv.indexOf(flag);
    const value = index === -1 ? undefined : argv[index + 1];
    if (!value) throw new Error(`${flag} is required.`);
    return value;
  };
  const sandbox: NpmSandbox = { root: option("--root"), cache: option("--cache") };
  const scope = option("--scope") as AuditScope;
  if (!AUDIT_SCOPES.includes(scope)) throw new Error(`--scope must be one of ${AUDIT_SCOPES.join(", ")}.`);

  const server = new Server({ name: "mcp-dependabot-tracker-npm", version: APP_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      return await callNpmTool(sandbox, scope, request.params.name, request.params.arguments);
    } catch (err: any) {
      return errorResult(err?.message ?? String(err));
    }
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await serveNpmTools(process.argv.slice(2));
}
