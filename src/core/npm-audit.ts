import { NPM_SEVERITIES, type Change, type ForceCandidate, type NpmSeverity, type Vulnerability } from "../../shared/schemas/model.schema.js";
import { TrackerError } from "./errors.js";

/** Contenu d'un `package-lock.json` utile ici : la version de chaque paquet installé, par chemin. */
export interface Lockfile {
  packages: Record<string, { version?: string }>;
}

/** Vulnérabilité lue dans un rapport, avec la correction que propose npm. */
export interface AuditedVulnerability extends Vulnerability {
  fixPackage: string | null;
  fixVersion: string | null;
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
 * jour ; une montée majeure demande `--force`.
 */
export function parseAuditReport(report: any, project: string): AuditedVulnerability[] {
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new TrackerError(`Unsupported npm audit report for ${projectLabel(project)}package-lock.json: expected auditReportVersion 2 (npm 7 or later).`);
  }
  return Object.values(report.vulnerabilities as Record<string, any>).map((entry) => {
    const severity = (NPM_SEVERITIES as readonly string[]).includes(entry.severity) ? (entry.severity as NpmSeverity) : "info";
    const fixAvailable = entry.fixAvailable;
    if (fixAvailable === true) {
      return { project, name: entry.name, severity, fix: "available", fixPackage: null, fixVersion: null };
    }
    if (fixAvailable && typeof fixAvailable === "object") {
      return {
        project,
        name: entry.name,
        severity,
        fix: fixAvailable.isSemVerMajor ? "major" : "available",
        fixPackage: fixAvailable.name,
        fixVersion: fixAvailable.version,
      };
    }
    return { project, name: entry.name, severity, fix: "none", fixPackage: null, fixVersion: null };
  });
}

/** Version installée d'un paquet de premier niveau dans le lockfile, ou null. */
function installedVersion(lock: Lockfile, name: string): string | null {
  return lock.packages[`node_modules/${name}`]?.version ?? null;
}

/**
 * Paquets que `npm audit fix --force` monterait d'une version majeure, un par
 * paquet et par projet, avec le nombre de vulnérabilités que cette montée corrige.
 */
export function forceCandidates(vulnerabilities: AuditedVulnerability[], locks: Record<string, Lockfile>): ForceCandidate[] {
  const byKey = new Map<string, ForceCandidate>();
  for (const vulnerability of vulnerabilities) {
    if (vulnerability.fix !== "major" || !vulnerability.fixPackage || !vulnerability.fixVersion) continue;
    const key = `${vulnerability.project}\0${vulnerability.fixPackage}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.vulnerabilities += 1;
      continue;
    }
    const lock = locks[vulnerability.project];
    byKey.set(key, {
      project: vulnerability.project,
      name: vulnerability.fixPackage,
      from: lock ? installedVersion(lock, vulnerability.fixPackage) : null,
      to: vulnerability.fixVersion,
      vulnerabilities: 1,
    });
  }
  return [...byKey.values()].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

/**
 * Paquets dont la version diffère entre deux lockfiles d'un projet. Le nom est
 * le chemin d'installation sans le premier `node_modules/` : `lodash`, ou
 * `d3-sankey/node_modules/d3-array` pour une copie imbriquée.
 */
export function diffLockfiles(before: Lockfile, after: Lockfile, project: string): Change[] {
  const keys = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
  const changes: Change[] = [];
  for (const key of keys) {
    if (!key.startsWith("node_modules/")) continue;
    const from = before.packages[key]?.version ?? null;
    const to = after.packages[key]?.version ?? null;
    if (from === to) continue;
    changes.push({ project, name: key.slice("node_modules/".length), from, to });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Lit un `package-lock.json` ; un lockfile v1 (npm 6), sans `packages`, est refusé. */
export function parseLockfile(text: string, project: string): Lockfile {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err: any) {
    throw new TrackerError(`${projectLabel(project)}package-lock.json is not valid JSON: ${err.message}`);
  }
  if (!json || typeof json.packages !== "object" || json.packages === null) {
    throw new TrackerError(`${projectLabel(project)}package-lock.json has no "packages" section: lockfile version 2 or 3 (npm 7 or later) is required.`);
  }
  return { packages: json.packages };
}

/** Préfixe d'affichage d'un projet : `""` pour la racine, `gui/` pour le dossier `gui`. */
export function projectLabel(project: string): string {
  return project === "" ? "" : `${project}/`;
}
