import { ALERT_SEVERITIES, STEP_NAMES, type AuditScope, type Operation, type Repo } from "../../shared/schemas/model.schema.js";
import type { RepoView } from "../../shared/schemas/api.schema.js";
import { pendingAlerts } from "../../shared/alerts.js";
import { projectLabel } from "../core/npm-audit.js";
import { countBySeverity } from "../core/repos.js";

/** Paquets cités en clair dans un résultat ; au-delà, le reste est compté. */
const MAX_LISTED = 25;

/** Périmètre d'un audit, en clair. */
function scopeLabel(scope: AuditScope): string {
  return scope === "production" ? "production dependencies" : "all dependencies";
}

/**
 * Alertes restantes par gravité, dont celles qui portent sur une dépendance de
 * développement, et le nombre de celles que l'utilisateur a corrigées à la main.
 */
function alertsLabel(repo: Repo): string {
  const pending = pendingAlerts(repo);
  const handled = repo.alerts.length - pending.length;
  const handledNote = handled > 0 ? ` + ${handled} fixed by hand by the user` : "";
  if (pending.length === 0) return `none${handledNote}`;
  const counts = countBySeverity(pending);
  const detail = ALERT_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => `${severity} ${counts[severity]}`);
  const development = pending.filter((alert) => alert.scope === "development").length;
  const developmentNote = development > 0 ? `; ${development} on development dependencies` : "";
  return `${pending.length} (${detail.join(", ")}${developmentNote})${handledNote}`;
}

/** Description d'un dépôt pour l'agent. */
export function describeRepo(view: RepoView): string {
  const { repo, activeOperation, category } = view;
  const lines = [
    `- ${repo.id} (analysed branch ${repo.branch}${repo.branch === repo.defaultBranch ? ", the default one" : `; default branch ${repo.defaultBranch}`})`,
    `  Category: ${category ? category.name : "none"}`,
    `  Open Dependabot alerts: ${alertsLabel(repo)}${repo.syncedAt ? ` · synced ${repo.syncedAt}` : " · not synced yet"}`,
  ];
  if (repo.syncError) lines.push(`  Last sync failed: ${repo.syncError}`);
  if (repo.pullRequests.length > 0) {
    lines.push(`  Pull requests opened by the tracker, not merged yet: ${repo.pullRequests.map((pull) => `#${pull.number} ${pull.url}`).join(", ")}`);
  }
  if (view.unfixable.length > 0) lines.push(`  Last npm audit found no published fix for: ${view.unfixable.join(", ")}`);
  if (view.cleanAudit) {
    const { at, scope } = view.cleanAudit;
    const alerts = scope === "production" ? "the Dependabot alerts on production dependencies" : "these Dependabot alerts";
    lines.push(`  npm audit of ${at} (${scopeLabel(scope)}) found no vulnerability on the default branch: ${alerts} are probably not refreshed yet.`);
  }
  if (view.cleanProductionAudit) {
    lines.push(`  npm audit of ${view.cleanProductionAudit.at} (production dependencies) found no vulnerability on the default branch; every open Dependabot alert is on a development dependency.`);
  }
  if (view.auditFindings) {
    const { at, scope, count, severity } = view.auditFindings;
    lines.push(
      `  npm audit of ${at} (${scopeLabel(scope)}) found ${count} vulnerabilit${count === 1 ? "y" : "ies"} (worst: ${severity}) on the default branch although Dependabot reports none there: Dependabot has probably not caught up yet.`
    );
  }
  if (activeOperation) lines.push(`  Operation in progress: ${activeOperation.id} (${activeOperation.kind})`);
  return lines.join("\n");
}

export function describeAlerts(repo: Repo): string {
  const header = `${repo.id}: ${repo.alerts.length} open Dependabot alert(s), synced ${repo.syncedAt}.`;
  const lines = repo.alerts.map((alert) => {
    const patched = alert.patchedVersion ? ` — patched in ${alert.patchedVersion}` : " — no patched version";
    const mark = repo.handledAlerts.find((candidate) => candidate.number === alert.number);
    const handled = mark ? ` — fixed by hand by the user on ${mark.markedAt}` : "";
    const scope = alert.scope ? `, ${alert.scope} dependency` : "";
    return `- #${alert.number} ${alert.severity} ${alert.package} (${alert.ecosystem}, ${alert.manifestPath}${scope}): ${alert.summary}${patched}${handled} — ${alert.url}`;
  });
  return [header, ...lines].join("\n");
}

function list<T>(items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED).map(render);
  if (items.length > MAX_LISTED) shown.push(`… and ${items.length - MAX_LISTED} more`);
  return shown.join(", ");
}

/** Libellé d'une étape, pour l'étape en cours. */
const STEP_LABELS: Record<(typeof STEP_NAMES)[number], string> = {
  clone: "cloning the repository",
  audit: "npm audit",
  fix: "npm audit fix",
  repair: "fixes by Claude",
  push: "commit, push and pull request",
};

/** Compte rendu d'une opération pour l'agent : avancement, vulnérabilités, paquets modifiés, corrections par Claude, PR, erreur. */
export function describeOperation(operation: Operation): string {
  const title = operation.kind === "audit" ? "npm audit" : "Fix";
  const lines = [`${title} of ${operation.repoId} (branch ${operation.baseBranch}), ${scopeLabel(operation.scope)} (operation ${operation.id}): ${operation.status}.`];
  if (operation.status === "running") {
    const step = STEP_NAMES.find((name) => operation.steps[name] === "running");
    if (step) lines.push(`- In progress: ${STEP_LABELS[step]}${operation.cancelRequested ? " (cancelling)" : ""}`);
    if (step === "repair" && operation.repair) lines.push(`- Claude: ${operation.repair.turns} turn(s); last actions: ${operation.repair.activity.join(" · ") || "none yet"}`);
  }
  if (operation.projects.length > 0) {
    lines.push(`- npm projects: ${operation.projects.map((project) => projectLabel(project) || "./").join(", ")}`);
  }
  const { initial, afterFix, afterRepair } = operation.counts;
  if (initial !== null) {
    const parts = [`${initial} found`];
    if (afterFix !== null) parts.push(`${afterFix} left after npm audit fix`);
    if (afterRepair !== null) parts.push(`${afterRepair} left after the fixes by Claude`);
    lines.push(`- Vulnerabilities: ${parts.join(", ")}`);
  }
  if (operation.remaining.length > 0) {
    lines.push(
      `- Remaining: ${list(operation.remaining, (vulnerability) => {
        const fix = vulnerability.fix === "none" ? "no fix" : vulnerability.fix === "major" ? "fix needs a major upgrade" : "fix available";
        return `${projectLabel(vulnerability.project)}${vulnerability.name} (${vulnerability.severity}, ${fix})`;
      })}`
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
  const repair = operation.repair;
  if (repair?.error) lines.push(`- Fixes by Claude failed: ${repair.error}`);
  if (repair?.report) {
    lines.push(`- Fixes by Claude: ${repair.report.summary}`);
    if (repair.report.changes.length > 0) lines.push(`- Files changed by Claude: ${list(repair.report.changes, (change) => change.file)}`);
    lines.push(`- Tests after the fixes by Claude: ${repair.report.tests.outcome.replace("_", " ")} — ${repair.report.tests.detail}`);
  }
  if (repair?.task) lines.push(`- Report of Claude: organizer task ${repair.task.key} ${repair.task.url}`);
  if (operation.pullRequest) {
    lines.push(`- Pull request #${operation.pullRequest.number}: ${operation.pullRequest.url} (branch ${operation.branch})`);
  } else if (operation.kind === "fix" && operation.status === "done") {
    lines.push("- No pull request: there was nothing to fix, or the fixes left the files unchanged.");
  }
  if (operation.error) lines.push(`- Error: ${operation.error}`);
  return lines.join("\n");
}
