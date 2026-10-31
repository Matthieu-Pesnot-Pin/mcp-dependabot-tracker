import { TASK_STATUSES } from "../../shared/schemas/model.schema.js";
import { TrackerError } from "./errors.js";

/**
 * Client de l'API agent d'un site organizer (`<url>/api/agent/…`), avec un
 * token d'agent : il couvre un espace, avec les droits de son créateur. Chaque
 * réponse réussie est une enveloppe `{ text, data }` ; une erreur porte `{ error }`.
 */

const REQUEST_TIMEOUT_MS = 30_000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface OrganizerConnection {
  /** Adresse publique du site, sans barre oblique finale. */
  url: string;
  token: string;
}

/** Espace du token et son propriétaire, à qui les tâches de l'analyse sont assignées. */
export interface OrganizerSpace {
  space: { id: string; name: string };
  owner: { id: string; name: string; email: string };
}

export interface OrganizerTask {
  id: string;
  key: string;
  title: string;
  status: (typeof TASK_STATUSES)[number];
  assigneeIds: string[];
  tags: string[];
}

/**
 * Adresse du site, validée : absolue, en https sauf pour un site de cette
 * machine (le token passerait en clair), sans identifiants, requête ni fragment.
 */
export function organizerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TrackerError(`The organizer address is not an absolute URL (${raw}): expected e.g. https://organizer.example.com.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TrackerError(`The organizer address must use http or https (${raw}).`);
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new TrackerError(`The organizer address must use https (${raw}): over http the token would travel in clear text. http is only accepted for a site on this machine.`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new TrackerError(`The organizer address must not contain credentials, a query or a fragment (${raw}).`);
  }
  return url.href.replace(/\/+$/, "");
}

export class OrganizerClient {
  constructor(private readonly connection: OrganizerConnection) {}

  /** Adresse de la page d'une tâche sur le site. */
  taskUrl(taskId: string): string {
    return `${this.connection.url}/#/task/${encodeURIComponent(taskId)}`;
  }

  /** Espace du token et son propriétaire. */
  async space(): Promise<OrganizerSpace> {
    const data = await this.get("context");
    const owner = Array.isArray(data?.members) ? data.members.find((member: any) => member?.role === "owner") : undefined;
    if (typeof data?.space?.id !== "string" || typeof data?.space?.name !== "string" || typeof owner?.id !== "string") {
      throw new TrackerError(`The organizer at ${this.connection.url} sent an unexpected context: check that it is up to date.`);
    }
    return { space: { id: data.space.id, name: data.space.name }, owner: { id: owner.id, name: String(owner.name), email: String(owner.email) } };
  }

  /** Tâche de l'espace, par sa clé (ex. `ORG-42`) ou son identifiant. */
  async task(ref: string): Promise<OrganizerTask> {
    const task = (await this.get(`tasks/${encodeURIComponent(ref)}`))?.task;
    if (
      typeof task?.id !== "string" ||
      typeof task.key !== "string" ||
      typeof task.title !== "string" ||
      !TASK_STATUSES.includes(task.status) ||
      !Array.isArray(task.assigneeIds) ||
      !Array.isArray(task.tags)
    ) {
      throw new TrackerError(`The organizer at ${this.connection.url} sent an unexpected answer for task ${ref}: check that it is up to date.`);
    }
    return { id: task.id, key: task.key, title: task.title, status: task.status, assigneeIds: task.assigneeIds, tags: task.tags };
  }

  /** Données d'une lecture de l'API agent. Une redirection n'est jamais suivie : le token ne part que vers l'adresse réglée. */
  private async get(path: string): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.connection.url}/api/agent/${path}`, {
        headers: { authorization: `Bearer ${this.connection.token}`, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new TrackerError(`Cannot reach the organizer at ${this.connection.url} (${err?.cause?.message ?? err?.message ?? err}).`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TrackerError(`The organizer at ${this.connection.url} answered with a redirect (HTTP ${response.status}): use the final https address of the site.`);
    }
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const reason = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new TrackerError(`The organizer at ${this.connection.url} refused the request: ${reason}`);
    }
    if (payload === null || typeof payload !== "object" || !("data" in payload)) {
      throw new TrackerError(`The organizer at ${this.connection.url} sent an unexpected answer: check the address of the site.`);
    }
    return payload.data;
  }
}
