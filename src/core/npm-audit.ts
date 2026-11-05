import { NPM_SEVERITIES, type Change, type NpmSeverity, type Vulnerability } from "../../shared/schemas/model.schema.js";
import { TrackerError } from "./errors.js";

/** Contenu d'un `package-lock.json` utile ici : la version de chaque paquet installé, par chemin. */
export interface Lockfile {
  packages: Record<string, { version?: string }>;
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
    if (fixAvailable === true) return { project, name: entry.name, severity, fix: "available" };
    if (fixAvailable && typeof fixAvailable === "object") return { project, name: entry.name, severity, fix: fixAvailable.isSemVerMajor ? "major" : "available" };
    return { project, name: entry.name, severity, fix: "none" };
  });
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
