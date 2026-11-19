import fs from "fs";
import path from "path";
import { NPM_SEVERITIES, type AuditScope, type FixKind, type NpmSeverity, type Vulnerability } from "../../../shared/schemas/model.schema.js";
import { tail } from "../commands.js";
import { CACHE_MOUNT, projectDir } from "../containers.js";
import { TrackerError } from "../errors.js";
import { NODE_IMAGE } from "./npm.js";
import { nameArg, onlyFields } from "./tool-args.js";
import { projectLabel, runManager, type Lockfile, type ManagerContext, type PackageManager } from "./types.js";

/**
 * Version de pnpm quand le projet n'en demande pas une plus récente : pnpm 11
 * est la première à interroger l'API d'audit du registre npm encore en service
 * (`/-/npm/v1/security/advisories/bulk`).
 */
export const PNPM_DEFAULT = "11";

/** Plus petite version majeure de pnpm qui sait auditer. */
const PNPM_MIN_MAJOR = 11;

/** Avis gardés par paquet dans les faits transmis à Claude, et chemins par avis. */
const MAX_ADVISORIES = 5;
const MAX_PATHS = 5;

/**
 * Variables des commandes pnpm : caches de l'opération, et la version de pnpm
 * choisie par le tracker, même quand `packageManager` en demande une autre
 * (`pm-on-fail=ignore`).
 */
const PNPM_ENV = {
  npm_config_cache: `${CACHE_MOUNT}/npm`,
  npm_config_update_notifier: "false",
  pnpm_config_store_dir: `${CACHE_MOUNT}/pnpm-store`,
  pnpm_config_pm_on_fail: "ignore",
  pnpm_config_update_notifier: "false",
};

/**
 * Version de pnpm à lancer pour un projet : celle de son champ `packageManager`
 * (`pnpm@12.1.0`) si elle sait auditer, `PNPM_DEFAULT` sinon.
 */
export function pnpmVersion(manifest: unknown): string {
  const field = (manifest as { packageManager?: unknown } | null)?.packageManager;
  const match = typeof field === "string" ? /^pnpm@(\d+)(\.\d+\.\d+[^+]*)?/.exec(field) : null;
  if (!match || Number(match[1]) < PNPM_MIN_MAJOR) return PNPM_DEFAULT;
  return `${match[1]}${match[2] ?? ""}`;
}

function readManifest(dir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  } catch (err: any) {
    throw new TrackerError(`package.json cannot be read: ${err.message}`);
  }
}

/** Options pnpm qui limitent l'audit et ses corrections au périmètre `scope`. */
function pnpmScopeArgs(scope: AuditScope): string[] {
  return scope === "production" ? ["--prod"] : [];
}

/** Version majeure de la plus petite version corrigée d'une plage `>=2.0.1`, ou null. */
function patchedMajor(patched: string): number | null {
  const match = />=\s*v?(\d+)/.exec(patched);
  return match ? Number(match[1]) : null;
}

/** Correction d'un avis pour la version installée : aucune, dans la même version majeure, ou par une version majeure. */
function fixOf(advisory: any): FixKind {
  if (typeof advisory.patched_versions !== "string" || advisory.patched_versions.trim() === "" || advisory.patched_versions.trim() === "<0.0.0") return "none";
  const target = patchedMajor(advisory.patched_versions);
  const installed = (advisory.findings ?? []).map((finding: any) => Number(String(finding.version).split(".")[0]));
  return target !== null && installed.some((major: number) => major < target) ? "major" : "available";
}

/** Avis d'un rapport `pnpm audit --json` ; lève une erreur sur un autre format. */
function advisoriesOf(report: any, project: string): any[] {
  if (!report || typeof report.advisories !== "object" || report.advisories === null) {
    throw new TrackerError(`Unsupported pnpm audit report for ${projectLabel(project)}pnpm-lock.yaml: expected an "advisories" object (pnpm 11 or later).`);
  }
  return Object.values(report.advisories);
}

/**
 * Vulnérabilités d'un rapport `pnpm audit --json`, une par paquet, par nom : la gravité
 * la plus haute de ses avis, et la correction la plus difficile parmi eux.
 */
export function parsePnpmAudit(report: any, project: string): Vulnerability[] {
  const byName = new Map<string, Vulnerability>();
  const rank = (fix: FixKind) => ["available", "major", "none"].indexOf(fix);
  for (const advisory of advisoriesOf(report, project)) {
    const severity = (NPM_SEVERITIES as readonly string[]).includes(advisory.severity) ? (advisory.severity as NpmSeverity) : "info";
    const fix = fixOf(advisory);
    const current = byName.get(advisory.module_name);
    if (!current) {
      byName.set(advisory.module_name, { project, manager: "pnpm", name: advisory.module_name, severity, fix });
      continue;
    }
    if (NPM_SEVERITIES.indexOf(severity) < NPM_SEVERITIES.indexOf(current.severity)) current.severity = severity;
    if (rank(fix) > rank(current.fix)) current.fix = fix;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Avis d'un rapport `pnpm audit --json`, regroupés par paquet et réduits à ce qui sert les corrections. */
export function pnpmFacts(report: any, project: string): unknown[] {
  const byName = new Map<string, any[]>();
  for (const advisory of advisoriesOf(report, project)) byName.set(advisory.module_name, [...(byName.get(advisory.module_name) ?? []), advisory]);
  return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, advisories]) => ({
    manager: "pnpm",
    project: project === "" ? "." : project,
    name,
    versions: [...new Set(advisories.flatMap((advisory) => (advisory.findings ?? []).map((finding: any) => finding.version)))],
    advisories: advisories.slice(0, MAX_ADVISORIES).map((advisory) => ({
      title: advisory.title,
      url: advisory.url,
      severity: advisory.severity,
      vulnerable: advisory.vulnerable_versions,
      patched: advisory.patched_versions ?? null,
      paths: (advisory.findings ?? []).flatMap((finding: any) => finding.paths ?? []).slice(0, MAX_PATHS),
      dev: (advisory.findings ?? []).some((finding: any) => finding.dev),
    })),
  }));
}

/**
 * Lit un `pnpm-lock.yaml` (format 9) : versions de chaque paquet de la section
 * `packages`, dont les clés sont `<nom>@<version>` ; les versions d'un paquet
 * installé en plusieurs exemplaires sont jointes, triées. Un autre format est
 * refusé.
 */
export function readPnpmLock(text: string, project: string): Lockfile {
  const lines = text.split(/\r?\n/);
  const version = /^lockfileVersion:\s*'?"?([\d.]+)/m.exec(text)?.[1];
  if (!version || Number(version.split(".")[0]) < 9) {
    throw new TrackerError(`${projectLabel(project)}pnpm-lock.yaml has lockfile version ${version ?? "unknown"}: version 9 (pnpm 9 or later) is required.`);
  }
  const all = new Map<string, Set<string>>();
  const start = lines.indexOf("packages:");
  for (let index = start + 1; start !== -1 && index < lines.length; index++) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    const key = /^ {2}(\S.*):\s*(\{\})?$/.exec(line)?.[1];
    if (!key) continue;
    const id = key.replace(/^['"]|['"]$/g, "");
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    const name = id.slice(0, at);
    all.set(name, (all.get(name) ?? new Set()).add(id.slice(at + 1)));
  }
  return Object.fromEntries([...all.entries()].map(([name, versions]) => [name, [...versions].sort().join(", ")]));
}

async function audit(ctx: ManagerContext, project: string): Promise<any> {
  const result = await runManager(pnpm, ctx, project, ["audit", ...pnpmScopeArgs(ctx.scope), "--json"]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new TrackerError(`pnpm audit in ${projectLabel(project) || "./"} did not return JSON: ${tail(result.stderr) || tail(result.stdout) || "no output"}`);
  }
}

export const pnpm: PackageManager = {
  id: "pnpm",
  lockfile: "pnpm-lock.yaml",
  manifest: "package.json",
  image: () => ({ name: NODE_IMAGE }),
  command: (ctx, project, args) => {
    const dir = projectDir(ctx.workspace, project, "package.json");
    return { image: NODE_IMAGE, cwd: project, command: ["npm", "exec", "--yes", `--package=pnpm@${pnpmVersion(readManifest(dir))}`, "--", "pnpm", ...args], env: PNPM_ENV };
  },
  audit: async (ctx, project) => {
    const report = await audit(ctx, project);
    return { vulnerabilities: parsePnpmAudit(report, project), facts: pnpmFacts(report, project) };
  },
  fix: async (ctx, project) => {
    const result = await runManager(pnpm, ctx, project, ["audit", "--fix=update", ...pnpmScopeArgs(ctx.scope), "--lockfile-only", "--ignore-scripts"]);
    if (!/\d+ vulnerabilit(y|ies) (was|were) fixed/.test(result.stdout)) {
      throw new TrackerError(`pnpm audit --fix=update failed in ${projectLabel(project) || "./"}: ${tail(result.stderr) || tail(result.stdout) || "no output"}`);
    }
  },
  readLock: readPnpmLock,
  fixCommand: (scope) => ["pnpm audit --fix=update", ...pnpmScopeArgs(scope), "--lockfile-only --ignore-scripts"].join(" "),
  tools: [
    {
      name: "pnpm_install_lockfile",
      description: "Run pnpm install --lockfile-only --ignore-scripts in a pnpm project: updates pnpm-lock.yaml after a change of a package.json or of the overrides, without installing node_modules.",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["install", "--lockfile-only", "--ignore-scripts"];
      },
    },
    {
      name: "pnpm_audit",
      description: "Run pnpm audit in a pnpm project, with the scope of the operation.",
      properties: {},
      required: [],
      args: (args, scope) => {
        onlyFields(args);
        return ["audit", ...pnpmScopeArgs(scope)];
      },
    },
    {
      name: "pnpm_install",
      description: "Run pnpm install --frozen-lockfile in a pnpm project: installs node_modules of every workspace package from pnpm-lock.yaml.",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["install", "--frozen-lockfile"];
      },
    },
    {
      name: "pnpm_test",
      description: "Run the test script of every workspace package that has one (pnpm -r --if-present run test).",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["-r", "--if-present", "run", "test"];
      },
    },
    {
      name: "pnpm_run",
      description: "Run a script of a package.json of a pnpm project: of the root package, or of the workspace package named by filter (pnpm --filter <filter> run <script>).",
      properties: {
        script: { type: "string", description: "Name of the script." },
        filter: { type: "string", description: "Name of a workspace package (optional)." },
      },
      required: ["script"],
      args: (args) => {
        onlyFields(args, ["script", "filter"]);
        const filter = args?.filter === undefined ? [] : ["--filter", nameArg(args, "filter")];
        return [...filter, "run", nameArg(args, "script")];
      },
    },
    {
      name: "pnpm_why",
      description: "Show which workspace packages depend on a package, and through which dependencies (pnpm why -r <package>).",
      properties: { package: { type: "string", description: "Name of the package." } },
      required: ["package"],
      args: (args) => {
        onlyFields(args, ["package"]);
        return ["why", "-r", nameArg(args, "package")];
      },
    },
  ],
  guide: (scope, server) =>
    [
      `- pnpm projects (pnpm-lock.yaml, one per workspace): upgrade a dependency in the package.json of its workspace package, or pin a transitive one with an \`overrides\` entry of pnpm-workspace.yaml, with Edit, then update the lockfile with the ${server} tool pnpm_install_lockfile.`,
      `  Check with pnpm_audit${scope === "production" ? " (it runs `pnpm audit --prod`)" : ""}; pnpm_install to install the dependencies, then pnpm_test (or pnpm_run) when the packages have tests; pnpm_why when useful.`,
    ].join("\n"),
};
