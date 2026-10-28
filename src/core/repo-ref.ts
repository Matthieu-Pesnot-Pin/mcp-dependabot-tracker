import { TrackerError } from "./errors.js";

export interface RepoRef {
  owner: string;
  name: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Lit `propriétaire/nom`, un lien web (`https://github.com/propriétaire/nom/…`)
 * ou une URL de clone (`…/nom.git`, `git@github.com:propriétaire/nom.git`).
 */
export function parseRepoRef(input: string): RepoRef {
  const raw = input.trim();
  let pathPart = raw;
  const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(raw);
  if (scp) {
    pathPart = scp[1];
  } else if (/^[a-z]+:\/\//i.test(raw)) {
    try {
      pathPart = new URL(raw).pathname;
    } catch {
      throw invalid(raw);
    }
  }
  const segments = pathPart.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) throw invalid(raw);
  const owner = segments[0];
  const name = segments[1].replace(/\.git$/, "");
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === "." || name === "..") throw invalid(raw);
  return { owner, name };
}

function invalid(raw: string): TrackerError {
  return new TrackerError(`"${raw}" is not a GitHub repository: expected owner/name or a github.com link.`);
}
