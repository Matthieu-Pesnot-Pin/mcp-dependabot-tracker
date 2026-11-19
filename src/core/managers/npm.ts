import { NPM_SEVERITIES, type AuditScope, type NpmSeverity, type Vulnerability } from "../../../shared/schemas/model.schema.js";
import { CACHE_MOUNT, projectDir } from "../containers.js";
import { TrackerError } from "../errors.js";
import { PACKAGES_PROPERTY, nameArg, onlyFields, packagesArg } from "./tool-args.js";
import { projectLabel, runManager, type Lockfile, type ManagerContext, type PackageManager } from "./types.js";

/** Image des commandes npm : Node.js LTS, npm compris. */
export const NODE_IMAGE = "docker.io/library/node:26-slim";

/**
 * Variables des commandes npm : cache de l'opération, ni avis de mise à jour
 * ni appel aux dons. `allow_remote` autorise le téléchargement des archives de
 * paquets à `bundleDependencies` (ex. `@tailwindcss/oxide-wasm32-wasi`), que
 * npm 12 classe en dépendances distantes avec `--package-lock-only`.
 */
const NPM_ENV = {
  npm_config_cache: `${CACHE_MOUNT}/npm`,
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_allow_remote: "all",
};

/** Chemins d'installation gardés par vulnérabilité dans les faits transmis à Claude. */
const MAX_NODES = 5;

/** Options npm qui limitent l'audit et ses corrections au périmètre `scope`. */
export function npmScopeArgs(scope: AuditScope): string[] {
  return scope === "production" ? ["--omit=dev"] : [];
}

/** Lit la sortie JSON d'un appel npm ; une sortie qui n'est pas du JSON, ou qui porte une erreur npm, lève une erreur. */
export function parseNpmJson(stdout: string, stderr: string, what: string): any {
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    const detail = stderr.trim() || stdout.trim() || "no output";
    throw new TrackerError(`${what} did not return JSON: ${detail.slice(-1500)}`);
  }
  if (json && typeof json === "object" && json.error) {
    const summary = json.error.summary ?? json.error.message ?? JSON.stringify(json.error);
    const detail = json.error.detail ? ` ${json.error.detail}` : "";
    throw new TrackerError(`${what} failed: ${summary}${detail}`.trim());
  }
  return json;
}

/**
 * Vulnérabilités d'un rapport `npm audit --json` (format `auditReportVersion` 2).
 * `fixAvailable` vaut false (aucune correction), true (dans les plages déclarées)
 * ou un objet `{ name, version, isSemVerMajor }` qui désigne le paquet à mettre à
 * jour, éventuellement d'une version majeure.
 */
export function parseAuditReport(report: any, project: string): Vulnerability[] {
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new TrackerError(`Unsupported npm audit report for ${projectLabel(project)}package-lock.json: expected auditReportVersion 2 (npm 7 or later).`);
  }
  return Object.values(report.vulnerabilities as Record<string, any>).map((entry) => {
    const severity = (NPM_SEVERITIES as readonly string[]).includes(entry.severity) ? (entry.severity as NpmSeverity) : "info";
    const fixAvailable = entry.fixAvailable;
    const base = { project, manager: "npm" as const, name: entry.name, severity };
    if (fixAvailable === true) return { ...base, fix: "available" as const };
    if (fixAvailable && typeof fixAvailable === "object") return { ...base, fix: fixAvailable.isSemVerMajor ? ("major" as const) : ("available" as const) };
    return { ...base, fix: "none" as const };
  });
}

/** Vulnérabilités d'un rapport `npm audit --json`, réduites à ce qui sert les corrections. */
export function auditFacts(report: any, project: string): unknown[] {
  return Object.values((report?.vulnerabilities ?? {}) as Record<string, any>).map((entry) => ({
    manager: "npm",
    project: project === "" ? "." : project,
    name: entry.name,
    severity: entry.severity,
    isDirect: entry.isDirect,
    range: entry.range,
    via: (Array.isArray(entry.via) ? entry.via : []).map((via: any) =>
      typeof via === "string" ? via : { title: via?.title, url: via?.url, range: via?.range, severity: via?.severity }
    ),
    effects: entry.effects,
    fixAvailable: entry.fixAvailable,
    nodes: (Array.isArray(entry.nodes) ? entry.nodes : []).slice(0, MAX_NODES),
  }));
}

/**
 * Lit un `package-lock.json` : version de chaque paquet installé, par chemin
 * d'installation sans le premier `node_modules/` (`lodash`, ou
 * `d3-sankey/node_modules/d3-array` pour une copie imbriquée). Un lockfile v1
 * (npm 6), sans `packages`, est refusé.
 */
export function readPackageLock(text: string, project: string): Lockfile {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err: any) {
    throw new TrackerError(`${projectLabel(project)}package-lock.json is not valid JSON: ${err.message}`);
  }
  if (!json || typeof json.packages !== "object" || json.packages === null) {
    throw new TrackerError(`${projectLabel(project)}package-lock.json has no "packages" section: lockfile version 2 or 3 (npm 7 or later) is required.`);
  }
  const versions: Lockfile = {};
  for (const [key, entry] of Object.entries(json.packages as Record<string, { version?: string }>)) {
    if (key.startsWith("node_modules/") && typeof entry?.version === "string") versions[key.slice("node_modules/".length)] = entry.version;
  }
  return versions;
}

async function audit(ctx: ManagerContext, project: string): Promise<any> {
  const args = ["audit", ...npmScopeArgs(ctx.scope), "--json"];
  const result = await runManager(npm, ctx, project, args);
  return parseNpmJson(result.stdout, result.stderr, `npm audit in ${projectLabel(project) || "./"}`);
}

export const npm: PackageManager = {
  id: "npm",
  lockfile: "package-lock.json",
  manifest: "package.json",
  image: () => ({ name: NODE_IMAGE }),
  command: (ctx, project, args) => {
    projectDir(ctx.workspace, project, "package.json");
    return { image: NODE_IMAGE, cwd: project, command: ["npm", ...args], env: NPM_ENV };
  },
  audit: async (ctx, project) => {
    const report = await audit(ctx, project);
    return { vulnerabilities: parseAuditReport(report, project), facts: auditFacts(report, project) };
  },
  fix: async (ctx, project) => {
    const result = await runManager(npm, ctx, project, ["audit", "fix", ...npmScopeArgs(ctx.scope), "--package-lock-only", "--ignore-scripts", "--json"]);
    parseNpmJson(result.stdout, result.stderr, `npm audit fix in ${projectLabel(project) || "./"}`);
  },
  readLock: readPackageLock,
  fixCommand: (scope) => ["npm audit fix", ...npmScopeArgs(scope), "--package-lock-only --ignore-scripts"].join(" "),
  tools: [
    {
      name: "npm_install_lockfile",
      description:
        "Run npm install --package-lock-only --ignore-scripts in an npm project: updates package-lock.json (and package.json for the packages given, e.g. mermaid@12.0.1) without installing node_modules. Use it after changing package.json or its overrides.",
      properties: { packages: PACKAGES_PROPERTY },
      required: [],
      args: (args) => {
        onlyFields(args, ["packages"]);
        return ["install", "--package-lock-only", "--ignore-scripts", ...packagesArg(args)];
      },
    },
    {
      name: "npm_audit",
      description: "Run npm audit in an npm project, with the scope of the operation.",
      properties: {},
      required: [],
      args: (args, scope) => {
        onlyFields(args);
        return ["audit", ...npmScopeArgs(scope)];
      },
    },
    {
      name: "npm_ci",
      description: "Run npm ci in an npm project: installs node_modules from package-lock.json, install scripts included.",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["ci"];
      },
    },
    {
      name: "npm_test",
      description: "Run npm test in an npm project.",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["test"];
      },
    },
    {
      name: "npm_run",
      description: "Run a script of package.json in an npm project (npm run <script>).",
      properties: { script: { type: "string", description: "Name of the script." } },
      required: ["script"],
      args: (args) => {
        onlyFields(args, ["script"]);
        return ["run", nameArg(args, "script")];
      },
    },
    {
      name: "npm_ls",
      description: "Show where a package is installed in the dependency tree of an npm project (npm ls <package> --all).",
      properties: { package: { type: "string", description: "Name of the package." } },
      required: ["package"],
      args: (args) => {
        onlyFields(args, ["package"]);
        return ["ls", nameArg(args, "package"), "--all"];
      },
    },
    {
      name: "tsc",
      description: "Type-check an npm project with its own TypeScript (npm exec --no -- tsc --noEmit).",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["exec", "--no", "--", "tsc", "--noEmit"];
      },
    },
  ],
  guide: (scope, server) =>
    [
      `- npm projects (package-lock.json): upgrade a dependency in package.json, or pin a transitive one with an \`overrides\` entry, with Edit, then update the lockfile with the ${server} tool npm_install_lockfile.`,
      `  Check with npm_audit${scope === "production" ? " (it runs `npm audit --omit=dev`)" : ""}; npm_ci to install the dependencies, then npm_test (or npm_run with the test script of package.json) when the project has some; npm_ls and tsc when useful.`,
    ].join("\n"),
};
