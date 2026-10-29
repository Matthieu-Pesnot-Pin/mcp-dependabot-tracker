import { DEFAULT_COMMIT_MESSAGE, type Operation, type Repo, type Right } from "../../shared/schemas/model.schema.js";
import type { RepoView } from "../../shared/schemas/api.schema.js";
import type { GitHubConfig } from "../core/config.js";
import { TrackerError } from "../core/errors.js";
import { runAgentOperation, type OperationContext } from "../core/operations.js";
import { listRepoViews, repoView, syncRepository } from "../core/repos.js";
import type { Store } from "../core/store.js";
import { describeAlerts, describeOperation, describeRepo } from "./format.js";
import { errorResult, optionalBoolean, optionalString, rejectUnknownFields, requireString, textResult, type Args, type ToolResult } from "./types.js";

const RIGHT_LABELS: Record<Right, string> = {
  audit: "run npm audit",
  fix: "run npm audit fix",
  force: "run npm audit fix --force",
  push: "push a branch and open a pull request",
};

/** Refuse l'action si l'utilisateur n'a pas accordé ce droit à l'agent pour ce dépôt. */
function assertAllowed(repo: Repo, right: Right): void {
  if (!repo.rights[right]) {
    throw new TrackerError(`The agent is not allowed to ${RIGHT_LABELS[right]} on ${repo.id}. Only the user can grant this right, in the GUI.`);
  }
}

/** Dépôts suivis non dépréciés, tous ou ceux d'une catégorie désignée par son nom, sans tenir compte de la casse. */
export function listRepositories(store: Store, args: Args): ToolResult {
  rejectUnknownFields(args, ["category"]);
  const categories = store.listCategories();
  const categoryName = optionalString(args, "category");
  let views = listRepoViews(store).filter((view) => view.repo.deprecatedAt === null);
  let scope = "tracked";
  if (categoryName !== undefined) {
    const category = categories.find((candidate) => candidate.name.toLowerCase() === categoryName.trim().toLowerCase());
    if (!category) {
      const known = categories.length === 0 ? "the user has created none" : `existing categories: ${categories.map((candidate) => candidate.name).join(", ")}`;
      throw new TrackerError(`Category "${categoryName}" does not exist (${known}).`);
    }
    views = views.filter((view) => view.repo.categoryId === category.id);
    scope = `in category ${category.name}`;
  }
  if (views.length === 0) {
    return textResult(categoryName === undefined ? "No repository is tracked. The user adds repositories in the GUI." : `No repository ${scope}.`);
  }
  const categoryOf = (view: RepoView) => categories.find((category) => category.id === view.repo.categoryId) ?? null;
  return textResult([`${views.length} repositor${views.length === 1 ? "y" : "ies"} ${scope}:`, ...views.map((view) => describeRepo(view, categoryOf(view)))].join("\n"));
}

/** Relit les alertes sur GitHub avant de les lister. */
export async function getAlerts(store: Store, config: GitHubConfig, args: Args): Promise<ToolResult> {
  rejectUnknownFields(args, ["repository"]);
  const repo = await syncRepository(store, config, store.getRepo(requireString(args, "repository")).id);
  if (repo.syncError) return errorResult(`Could not read the Dependabot alerts of ${repo.id}: ${repo.syncError}`);
  return textResult(describeAlerts(repoView(store, repo).repo));
}

/** Résultat d'un outil qui a mené une opération, avec l'opération pour lier son écran de la GUI. */
export interface OperationToolResult {
  result: ToolResult;
  operation: Operation;
}

function operationResult(operation: Operation): OperationToolResult {
  const text = describeOperation(operation);
  return { result: operation.status === "done" ? textResult(text) : errorResult(text), operation };
}

export async function runAudit(ctx: OperationContext, args: Args): Promise<OperationToolResult> {
  rejectUnknownFields(args, ["repository"]);
  const repo = ctx.store.getRepo(requireString(args, "repository"));
  assertAllowed(repo, "audit");
  return operationResult(await runAgentOperation(ctx, repo.id, "audit", { force: false, push: false, commitMessage: DEFAULT_COMMIT_MESSAGE }));
}

export async function fixVulnerabilities(ctx: OperationContext, args: Args): Promise<OperationToolResult> {
  rejectUnknownFields(args, ["repository", "force", "push", "commit_message"]);
  const repo = ctx.store.getRepo(requireString(args, "repository"));
  const force = optionalBoolean(args, "force", false);
  const push = optionalBoolean(args, "push", false);
  const commitMessage = optionalString(args, "commit_message") ?? DEFAULT_COMMIT_MESSAGE;
  assertAllowed(repo, "fix");
  if (force) assertAllowed(repo, "force");
  if (push) assertAllowed(repo, "push");
  return operationResult(await runAgentOperation(ctx, repo.id, "fix", { force, push, commitMessage }));
}
