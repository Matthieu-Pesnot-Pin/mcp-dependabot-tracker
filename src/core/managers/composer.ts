import fs from "fs";
import path from "path";
import type { AuditScope, NpmSeverity, Vulnerability } from "../../../shared/schemas/model.schema.js";
import { tail } from "../commands.js";
import { CACHE_MOUNT, projectDir } from "../containers.js";
import { TrackerError } from "../errors.js";
import { phpVersionFor } from "./php-version.js";
import { checkedName, nameArg, onlyFields } from "./tool-args.js";
import { projectLabel, runManager, type ImageSpec, type Lockfile, type ManagerContext, type PackageManager } from "./types.js";

/** Image des commandes Composer d'un projet en PHP `version`, construite par le tracker. */
export function composerImage(version: string): ImageSpec {
  return {
    name: `localhost/mcp-dependabot-tracker/composer:php${version}`,
    containerfile: [
      `FROM docker.io/library/php:${version}-cli`,
      "COPY --from=docker.io/composer/composer:2-bin /composer /usr/bin/composer",
      "RUN apt-get update && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/*",
      "",
    ].join("\n"),
  };
}

/** Variables des commandes Composer : dossiers et cache de l'opération, aucune question. */
const COMPOSER_ENV = {
  COMPOSER_HOME: `${CACHE_MOUNT}/composer`,
  COMPOSER_CACHE_DIR: `${CACHE_MOUNT}/composer-cache`,
  COMPOSER_NO_INTERACTION: "1",
};

/** Options qui empêchent les scripts et les plugins Composer du projet de s'exécuter. */
const NO_CODE = ["--no-scripts", "--no-plugins"];

/**
 * Mise à jour du lockfile seul : sans installation, sans scripts ni plugins,
 * sans audit, et sans exiger les extensions PHP du projet, que l'image n'a pas
 * forcément et qui ne changent pas la résolution.
 */
const LOCK_ONLY_UPDATE = ["--with-all-dependencies", "--no-install", ...NO_CODE, "--no-audit", "--ignore-platform-req=ext-*"];

/** Code de sortie de Composer quand les dépendances ne peuvent pas être résolues. */
const UNRESOLVABLE = 2;

/** Avis gardés par paquet dans les faits transmis à Claude. */
const MAX_ADVISORIES = 5;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err: any) {
    throw new TrackerError(`${path.basename(file)} cannot be read: ${err.message}`);
  }
}

/** Version de PHP d'un projet du clone, d'après son composer.json. */
function phpVersion(dir: string): string {
  try {
    return phpVersionFor(readJson(path.join(dir, "composer.json")));
  } catch (err: any) {
    throw new TrackerError(err.message);
  }
}

/** Gravité d'un avis Composer sur l'échelle de npm ; un avis sans gravité compte comme `info`. */
function severityOf(severity: unknown): NpmSeverity {
  if (severity === "critical" || severity === "high" || severity === "low") return severity;
  if (severity === "medium") return "moderate";
  return "info";
}

/** Avis d'un rapport `composer audit --format=json`, par paquet ; PHP sérialise une liste en tableau ou en objet. */
function advisoriesOf(report: any, project: string): [string, any[]][] {
  if (!report || typeof report.advisories !== "object" || report.advisories === null) {
    throw new TrackerError(`Unsupported composer audit report for ${projectLabel(project)}composer.lock: expected an "advisories" entry.`);
  }
  return Object.entries(report.advisories as Record<string, unknown>)
    .map(([name, list]): [string, any[]] => [name, Array.isArray(list) ? list : Object.values(list as object)])
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Vulnérabilités d'un rapport `composer audit --format=json`, une par paquet,
 * avec la gravité la plus haute de ses avis. Composer ne dit pas quelle version
 * corrige un avis : la correction est inconnue.
 */
export function parseComposerAudit(report: any, project: string): Vulnerability[] {
  const severities = ["critical", "high", "moderate", "low", "info"];
  return advisoriesOf(report, project).map(([name, advisories]) => ({
    project,
    manager: "composer" as const,
    name,
    severity: advisories.map((advisory) => severityOf(advisory.severity)).sort((a, b) => severities.indexOf(a) - severities.indexOf(b))[0] ?? "info",
    fix: "unknown" as const,
  }));
}

/** Avis d'un rapport `composer audit`, réduits à ce qui sert les corrections, avec la version installée d'après le lockfile. */
export function composerFacts(report: any, project: string, installed: Lockfile): unknown[] {
  return advisoriesOf(report, project).map(([name, advisories]) => ({
    manager: "composer",
    project: project === "" ? "." : project,
    name,
    installed: installed[name] ?? null,
    advisories: advisories.slice(0, MAX_ADVISORIES).map((advisory) => ({
      title: advisory.title,
      cve: advisory.cve ?? null,
      link: advisory.link ?? null,
      severity: advisory.severity ?? null,
      affectedVersions: advisory.affectedVersions,
    })),
  }));
}

/** Lit un `composer.lock` : version de chaque paquet de `packages` et de `packages-dev`. */
export function readComposerLock(text: string, project: string): Lockfile {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err: any) {
    throw new TrackerError(`${projectLabel(project)}composer.lock is not valid JSON: ${err.message}`);
  }
  if (!json || !Array.isArray(json.packages)) throw new TrackerError(`${projectLabel(project)}composer.lock has no "packages" list.`);
  const versions: Lockfile = {};
  for (const entry of [...json.packages, ...(Array.isArray(json["packages-dev"]) ? json["packages-dev"] : [])]) {
    if (typeof entry?.name === "string" && typeof entry?.version === "string") versions[entry.name] = entry.version;
  }
  return versions;
}

/** Options Composer qui limitent l'audit au périmètre `scope`. */
function composerScopeArgs(scope: AuditScope): string[] {
  return scope === "production" ? ["--no-dev"] : [];
}

export const composer: PackageManager = {
  id: "composer",
  lockfile: "composer.lock",
  manifest: "composer.json",
  image: (ctx, project) => composerImage(phpVersion(projectDir(ctx.workspace, project, "composer.json"))),
  command: (ctx, project, args) => {
    const dir = projectDir(ctx.workspace, project, "composer.json");
    return { image: composerImage(phpVersion(dir)).name, cwd: project, command: ["composer", ...args], env: COMPOSER_ENV };
  },
  audit: async (ctx, project) => {
    const result = await runManager(composer, ctx, project, ["audit", "--locked", "--format=json", ...composerScopeArgs(ctx.scope), ...NO_CODE]);
    let report: any;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new TrackerError(`composer audit in ${projectLabel(project) || "./"} did not return JSON: ${tail(result.stderr) || tail(result.stdout) || "no output"}`);
    }
    const lock = readComposerLock(fs.readFileSync(path.join(ctx.workspace.root, project, "composer.lock"), "utf-8"), project);
    return { vulnerabilities: parseComposerAudit(report, project), facts: composerFacts(report, project, lock) };
  },
  fix: async (ctx, project, vulnerabilities) => {
    const packages = vulnerabilities.map((vulnerability) => checkedName(vulnerability.name, "package"));
    const result = await runManager(composer, ctx, project, ["update", ...packages, ...LOCK_ONLY_UPDATE]);
    if (result.code === UNRESOLVABLE) {
      ctx.log(`Composer found no update of the vulnerable packages within the constraints of composer.json: ${tail(result.stderr, 6) || tail(result.stdout, 6)}`);
      return;
    }
    if (result.code !== 0) throw new TrackerError(`composer update failed in ${projectLabel(project) || "./"}: ${tail(result.stderr) || tail(result.stdout) || "no output"}`);
  },
  readLock: readComposerLock,
  fixCommand: () => ["composer update <vulnerable packages>", ...LOCK_ONLY_UPDATE].join(" "),
  tools: [
    {
      name: "composer_update_lock",
      description:
        "Run composer update <packages> --with-all-dependencies --no-install --no-scripts --no-plugins --ignore-platform-req=ext-* in a Composer project: updates composer.lock for the packages given, within the constraints of composer.json, without installing vendor/. Use it after changing a constraint in composer.json.",
      properties: { packages: { type: "array", items: { type: "string" }, description: "Packages to update, e.g. guzzlehttp/psr7." } },
      required: ["packages"],
      args: (args) => {
        onlyFields(args, ["packages"]);
        const packages = args?.packages;
        if (!Array.isArray(packages) || packages.length === 0 || packages.some((item) => typeof item !== "string")) throw new Error('"packages" must be a non-empty list of package names.');
        return ["update", ...packages.map((item: string) => checkedName(item.trim(), "packages")), ...LOCK_ONLY_UPDATE];
      },
    },
    {
      name: "composer_audit",
      description: "Run composer audit --locked in a Composer project, with the scope of the operation.",
      properties: {},
      required: [],
      args: (args, scope) => {
        onlyFields(args);
        return ["audit", "--locked", ...composerScopeArgs(scope), ...NO_CODE];
      },
    },
    {
      name: "composer_install",
      description: "Run composer install in a Composer project: installs vendor/ from composer.lock, scripts and plugins included. The image has the PHP version of the project but only the default extensions of the official PHP image.",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["install"];
      },
    },
    {
      name: "composer_test",
      description: "Run the test script of composer.json in a Composer project (composer run-script test).",
      properties: {},
      required: [],
      args: (args) => {
        onlyFields(args);
        return ["run-script", "test"];
      },
    },
    {
      name: "composer_run",
      description: "Run a script of composer.json in a Composer project (composer run-script <script>).",
      properties: { script: { type: "string", description: "Name of the script." } },
      required: ["script"],
      args: (args) => {
        onlyFields(args, ["script"]);
        return ["run-script", nameArg(args, "script")];
      },
    },
    {
      name: "composer_why",
      description: "Show which packages depend on a package in a Composer project, as a tree (composer depends --locked --tree <package>).",
      properties: { package: { type: "string", description: "Name of the package, e.g. guzzlehttp/psr7." } },
      required: ["package"],
      args: (args) => {
        onlyFields(args, ["package"]);
        return ["depends", "--locked", "--tree", nameArg(args, "package")];
      },
    },
  ],
  guide: (scope, server) =>
    [
      `- Composer projects (composer.lock): composer audit gives no fixed version, only the affected ranges: find the fixed version in the advisory. Widen the constraint of the package in composer.json with Edit when the fix needs it, then update the lockfile with the ${server} tool composer_update_lock.`,
      `  Check with composer_audit${scope === "production" ? " (it runs `composer audit --no-dev`)" : ""}; composer_install to install the dependencies, then composer_test (or composer_run) when composer.json has a test script; composer_why when useful. A missing PHP extension in the container is not a failure of your fixes: say so in your report.`,
    ].join("\n"),
};
