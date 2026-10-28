import { ALERT_SEVERITIES, RIGHTS, type Operation, type Repo } from "../../shared/schemas/model.schema.js";
import type { RepoView } from "../../shared/schemas/api.schema.js";
import { projectLabel } from "../core/npm-audit.js";
import { countBySeverity } from "../core/repos.js";

/** Paquets cités en clair dans un résultat ; au-delà, le reste est compté. */
const MAX_LISTED = 25;

export function rightsLabel(repo: Repo): string {
  const allowed = RIGHTS.filter((right) => repo.rights[right]);
  return allowed.length === 0 ? "none" : allowed.join(", ");
}

function alertsLabel(repo: Repo): string {
  if (repo.alerts.length === 0) return "none";
  const counts = countBySeverity(repo.alerts);
  const detail = ALERT_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => `${severity} ${counts[severity]}`);
  return `${repo.alerts.length} (${detail.join(", ")})`;
}

export function describeRepo(view: RepoView): string {
  const { repo, activeOperation } = view;
  const lines = [
    `- ${repo.id} (analysed branch ${repo.branch}${repo.branch === repo.defaultBranch ? ", the default one" : `; default branch ${repo.defaultBranch}`})`,
    `  Open Dependabot alerts: ${alertsLabel(repo)}${repo.syncedAt ? ` · synced ${repo.syncedAt}` : " · not synced yet"}`,
  ];
  if (repo.syncError) lines.push(`  Last sync failed: ${repo.syncError}`);
  lines.push(`  Agent rights: ${rightsLabel(repo)}`);
  if (activeOperation) lines.push(`  Operation in progress: ${activeOperation.id} (${activeOperation.status})`);
  return lines.join("\n");
}

export function describeAlerts(repo: Repo): string {
  const header = `${repo.id}: ${repo.alerts.length} open Dependabot alert(s), synced ${repo.syncedAt}.`;
  const lines = repo.alerts.map((alert) => {
    const patched = alert.patchedVersion ? ` — patched in ${alert.patchedVersion}` : " — no patched version";
    return `- #${alert.number} ${alert.severity} ${alert.package} (${alert.ecosystem}, ${alert.manifestPath}): ${alert.summary}${patched} — ${alert.url}`;
  });
  return [header, ...lines].join("\n");
}

function list<T>(items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED).map(render);
  if (items.length > MAX_LISTED) shown.push(`… and ${items.length - MAX_LISTED} more`);
  return shown.join(", ");
}

/** Compte rendu d'une opération pour l'agent : étapes, vulnérabilités, paquets modifiés, PR, erreur. */
export function describeOperation(operation: Operation): string {
  const title = operation.kind === "audit" ? "npm audit" : "npm audit fix";
  const lines = [`${title} on ${operation.repoId} (operation ${operation.id}): ${operation.status}.`];
  if (operation.projects.length > 0) {
    lines.push(`- npm projects: ${operation.projects.map((project) => projectLabel(project) || "./").join(", ")}`);
  }
  const { initial, afterFix, afterForce } = operation.counts;
  if (initial !== null) {
    const parts = [`${initial} found`];
    if (afterFix !== null) parts.push(`${afterFix} left after npm audit fix`);
    if (afterForce !== null) parts.push(`${afterForce} left after npm audit fix --force`);
    lines.push(`- Vulnerabilities: ${parts.join(", ")}`);
  }
  if (operation.remaining.length > 0) {
    lines.push(
      `- Remaining: ${list(operation.remaining, (vulnerability) => {
        const fix = vulnerability.fix === "none" ? "no fix" : vulnerability.fix === "major" ? "fix needs --force" : "fix available";
        return `${projectLabel(vulnerability.project)}${vulnerability.name} (${vulnerability.severity}, ${fix})`;
      })}`
    );
  }
  if (operation.forceCandidates.length > 0 && operation.steps.force !== "done") {
    lines.push(
      `- npm audit fix --force would upgrade: ${list(
        operation.forceCandidates,
        (candidate) => `${projectLabel(candidate.project)}${candidate.name} ${candidate.from ?? "?"} → ${candidate.to}`
      )}`
    );
  }
  if (operation.changes.length > 0) {
    lines.push(
      `- Updated packages (${operation.changes.length}): ${list(
        operation.changes,
        (change) => `${projectLabel(change.project)}${change.name} ${change.from ?? "(added)"} → ${change.to ?? "(removed)"}`
      )}`
    );
  }
  if (operation.pullRequest) {
    lines.push(`- Pull request #${operation.pullRequest.number}: ${operation.pullRequest.url} (branch ${operation.branch})`);
  } else if (operation.kind === "fix" && operation.status === "done" && operation.changes.length > 0) {
    lines.push("- Nothing was pushed: the clone was discarded.");
  }
  if (operation.error) lines.push(`- Error: ${operation.error}`);
  return lines.join("\n");
}
