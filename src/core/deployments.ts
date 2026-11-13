import crypto from "crypto";
import fs from "fs";
import path from "path";
import { StringDecoder } from "string_decoder";
import type { Client, ClientChannel } from "ssh2";
import { DeploymentSchema, type Deployment, type DeploymentSummary, type RepoDeployResponse } from "../../shared/schemas/deploy.schema.js";
import type { GitHubConfig } from "./config.js";
import type { DeployServerStore } from "./deploy-servers.js";
import { ConflictError, NotFoundError, TrackerError } from "./errors.js";
import { GitHubClient } from "./github.js";
import { connectSsh, openExec } from "./ssh.js";
import { assertNotDeprecated, type Store } from "./store.js";

/** Déploiements terminés conservés par dépôt ; les plus anciens sont supprimés. */
const KEPT_DEPLOYMENTS_PER_REPO = 20;

/** Taille maximale de la sortie gardée : au-delà, seule la fin est conservée. */
export const OUTPUT_LIMIT = 200_000;

/** Intervalle d'écriture de la sortie pendant l'exécution. */
const FLUSH_MS = 500;

const DEPLOYMENT_ID_PATTERN = /^[a-z0-9-]+$/;

/** Ligne de trace de bash pour une ligne du script : `+__DT<fichier>:<ligne>__ commande`. */
const TRACE_LINE = /^\++__DT([^:]*):(\d+)__ /;

const PID_MARKER = /__DTPID_(\d+)__/;

/** Nom du fichier du script sur le serveur, celui que porte la trace de ses lignes. */
const SCRIPT_FILE = "deploy.sh";

function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Valeur entre apostrophes pour sh : `'` devient `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Script transmis à `sh -s` : écrit le script de déploiement et son lanceur
 * dans un dossier temporaire, puis exécute le lanceur avec bash, l'entrée
 * venant de /dev/null, depuis le dossier personnel. Le lanceur envoie la
 * sortie du script sur stdout et la trace de bash (`set -x`) sur stderr, d'où
 * le tracker lit la ligne en cours ; le numéro du processus, lu au début de
 * stderr, sert à interrompre tout le groupe.
 */
export function remoteWrapper(script: string, variables: Record<string, string>): string {
  const token = crypto.randomBytes(8).toString("hex");
  const body = script.endsWith("\n") ? script : `${script}\n`;
  const exports = Object.entries(variables)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  return [
    `d=$(mktemp -d) || exit 1`,
    `trap 'rm -rf "$d"' EXIT`,
    `cat > "$d/${SCRIPT_FILE}" <<'DTSCRIPT_${token}'`,
    `${body}DTSCRIPT_${token}`,
    `cat > "$d/run.sh" <<'DTRUN_${token}'`,
    `exec 3>&2 2>&1`,
    exports,
    `BASH_XTRACEFD=3`,
    `PS4='+__DT\${BASH_SOURCE[0]##*/}:\${LINENO}__ '`,
    `set -x`,
    `. "$1"`,
    `DTRUN_${token}`,
    `printf '__DTPID_%s__\\n' "$$" >&2`,
    `cd`,
    `bash "$d/run.sh" "$d/${SCRIPT_FILE}" </dev/null`,
    `exit $?`,
    ``,
  ].join("\n");
}

/** Lit la trace de bash ligne à ligne et rend la dernière ligne du script commencée. */
export class TraceReader {
  private buffer = "";
  pid: number | null = null;

  constructor(private readonly onLine: (line: number) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const pid = PID_MARKER.exec(line);
      if (pid && this.pid === null) {
        this.pid = Number(pid[1]);
        continue;
      }
      const trace = TRACE_LINE.exec(line);
      if (trace && trace[1] === SCRIPT_FILE) this.onLine(Number(trace[2]));
    }
  }
}

/** Ajoute `text` à la sortie ; au-delà de la limite, seule la fin est gardée. */
export function appendOutput(output: string, text: string): { output: string; truncated: boolean } {
  const joined = output + text;
  if (joined.length <= OUTPUT_LIMIT) return { output: joined, truncated: false };
  return { output: joined.slice(joined.length - OUTPUT_LIMIT), truncated: true };
}

export function deploymentSummary({ script: _script, output: _output, ...summary }: Deployment): DeploymentSummary {
  return summary;
}

/** Déploiements : `<données>/deployments/<id>.json`, écrits par le seul serveur. */
export class DeploymentStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "deployments");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private pathOf(id: string): string {
    if (!DEPLOYMENT_ID_PATTERN.test(id)) throw new NotFoundError(`Deployment "${id}" not found.`);
    return path.join(this.dir, `${id}.json`);
  }

  private readFile(file: string): Deployment | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const parsed = DeploymentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new TrackerError(`${file} is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  private readAll(): Deployment[] {
    const deployments: Deployment[] = [];
    for (const entry of fs.readdirSync(this.dir)) {
      if (!entry.endsWith(".json")) continue;
      const deployment = this.readFile(path.join(this.dir, entry));
      if (deployment) deployments.push(deployment);
    }
    return deployments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Déploiements d'un dépôt, du plus récent au plus ancien. */
  list(repoId: string): Deployment[] {
    const key = repoId.toLowerCase();
    return this.readAll().filter((deployment) => deployment.repoId.toLowerCase() === key);
  }

  get(id: string): Deployment {
    const deployment = this.readFile(this.pathOf(id));
    if (!deployment) throw new NotFoundError(`Deployment "${id}" not found.`);
    return deployment;
  }

  active(repoId: string): Deployment | null {
    return this.list(repoId).find((deployment) => deployment.status === "running") ?? null;
  }

  /** Enregistre un déploiement ; refusé si un autre est en cours sur le dépôt. Au-delà des 20 plus récents, les anciens sont supprimés. */
  create(deployment: Deployment): Deployment {
    const existing = this.list(deployment.repoId);
    const active = existing.find((candidate) => candidate.status === "running");
    if (active) throw new ConflictError(`A deployment is already running on ${deployment.repoId}: wait for it to finish or interrupt it.`);
    writeJsonAtomic(this.pathOf(deployment.id), DeploymentSchema.parse(deployment));
    for (const old of existing.slice(KEPT_DEPLOYMENTS_PER_REPO - 1)) fs.rmSync(this.pathOf(old.id), { force: true });
    return deployment;
  }

  update(id: string, fn: (deployment: Deployment) => Deployment): Deployment {
    const updated = DeploymentSchema.parse({ ...fn(this.get(id)), updatedAt: new Date().toISOString() });
    writeJsonAtomic(this.pathOf(id), updated);
    return updated;
  }

  /** Supprime les déploiements d'un dépôt retiré du suivi. */
  removeRepo(repoId: string): void {
    for (const deployment of this.list(repoId)) fs.rmSync(this.pathOf(deployment.id), { force: true });
  }

  /** Déploiements encore `running` au démarrage du serveur, que son arrêt a interrompus : ils passent en échec. */
  failInterrupted(): Deployment[] {
    return this.readAll()
      .filter((deployment) => deployment.status === "running")
      .map((deployment) =>
        this.update(deployment.id, (current) => ({
          ...current,
          status: "failed",
          endedAt: new Date().toISOString(),
          error: "Interrompu : le serveur du tracker s'est arrêté pendant le déploiement.",
        }))
      );
  }
}

interface RunningDeployment {
  client: Client;
  channel: ClientChannel;
  trace: TraceReader;
}

/**
 * Déploiement des dépôts : chaque dépôt choisit un serveur et un script ; un
 * déploiement exécute ce script sur le serveur, par SSH, et en suit la ligne en
 * cours et la sortie. Un déploiement réussi retire la marque « à déployer ».
 */
export class Deployer {
  private readonly running = new Map<string, RunningDeployment>();

  constructor(
    private readonly store: Store,
    readonly servers: DeployServerStore,
    readonly deployments: DeploymentStore,
    private readonly github: GitHubConfig,
    private readonly logError: (message: string) => void
  ) {}

  /** Serveur, script, déploiement en cours et derniers déploiements d'un dépôt. */
  view(repoId: string): RepoDeployResponse {
    const repo = this.store.getRepo(repoId);
    const deployments = this.deployments.list(repo.id);
    return {
      server: repo.deployServerId === null ? null : this.servers.view(this.servers.get(repo.deployServerId)),
      script: repo.deployScript,
      activeDeployment: deployments.find((deployment) => deployment.status === "running") ?? null,
      deployments: deployments.map(deploymentSummary),
    };
  }

  setServer(repoId: string, serverId: string | null): RepoDeployResponse {
    if (serverId !== null) this.servers.get(serverId);
    const repo = this.store.getRepo(repoId);
    if (this.deployments.active(repo.id)) throw new ConflictError(`A deployment is running on ${repo.id}: wait for it to finish before changing its server.`);
    this.store.updateRepo(repo.id, (current) => ({ ...current, deployServerId: serverId }));
    return this.view(repo.id);
  }

  saveScript(repoId: string, script: string): RepoDeployResponse {
    const repo = this.store.getRepo(repoId);
    this.store.updateRepo(repo.id, (current) => ({ ...current, deployScript: script.replace(/\r\n/g, "\n") }));
    return this.view(repo.id);
  }

  /** Lance le script du dépôt sur son serveur ; le déploiement se poursuit en arrière-plan. */
  async start(repoId: string): Promise<Deployment> {
    const repo = this.store.getRepo(repoId);
    assertNotDeprecated(repo);
    if (repo.deployServerId === null) throw new ConflictError(`${repo.id} has no deployment server: connect one first.`);
    if (!repo.deployScript.trim()) throw new ConflictError(`${repo.id} has no deployment script: write it first.`);
    const server = this.servers.get(repo.deployServerId);
    if (server.testedAt === null) throw new ConflictError(`The connection to ${server.name} has not been tested: test it before deploying.`);
    if (this.deployments.active(repo.id)) throw new ConflictError(`A deployment is already running on ${repo.id}: wait for it to finish or interrupt it.`);

    const commit = await new GitHubClient(this.github).getBranchCommit(repo.owner, repo.name, repo.branch);
    const now = new Date().toISOString();
    const deployment = this.deployments.create({
      id: `dep-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      repoId: repo.id,
      serverId: server.id,
      server: `${server.name} · ${server.username}@${server.host}:${server.port}`,
      branch: repo.branch,
      commit,
      script: repo.deployScript,
      status: "running",
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      currentLine: null,
      exitCode: null,
      output: "",
      outputTruncated: false,
      cancelRequested: false,
      error: null,
    });
    void this.run(deployment).catch((err: any) => this.logError(`Deployment ${deployment.id} crashed: ${err?.stack ?? err}`));
    return deployment;
  }

  /** Interrompt un déploiement en cours : le groupe de processus du script reçoit SIGTERM, puis la connexion est fermée. */
  async cancel(id: string): Promise<Deployment> {
    const deployment = this.deployments.get(id);
    if (deployment.status !== "running") throw new ConflictError(`Deployment ${id} is not running (${deployment.status}).`);
    const updated = this.deployments.update(id, (current) => ({ ...current, cancelRequested: true }));
    const running = this.running.get(id);
    if (running) {
      const pid = running.trace.pid;
      if (pid !== null) {
        try {
          const killer = await openExec(running.client, `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid}`);
          await new Promise<void>((resolve) => killer.on("close", () => resolve()).resume());
        } catch {
          // La fermeture du canal ci-dessous arrête le script quand le signal n'a pas pu être envoyé.
        }
      }
      running.channel.close();
    }
    return updated;
  }

  private async run(initial: Deployment): Promise<void> {
    const id = initial.id;
    let output = "";
    let truncated = false;
    let currentLine: number | null = null;
    let dirty = false;

    const flush = () => {
      if (!dirty) return;
      dirty = false;
      const [snapshot, wasTruncated, line] = [output, truncated, currentLine];
      this.deployments.update(id, (current) => ({ ...current, output: snapshot, outputTruncated: wasTruncated, currentLine: line }));
    };
    const finish = (fields: Partial<Deployment>) => {
      this.running.delete(id);
      const [snapshot, wasTruncated, line] = [output, truncated, currentLine];
      const done = this.deployments.update(id, (current) => {
        const status = current.cancelRequested && fields.status !== "done" ? "cancelled" : fields.status!;
        return { ...current, ...fields, status, output: snapshot, outputTruncated: wasTruncated, currentLine: line, endedAt: new Date().toISOString() };
      });
      if (done.status === "done") this.store.updateRepo(done.repoId, (repo) => ({ ...repo, deployPendingAt: null }));
    };

    let client: Client;
    try {
      ({ client } = await connectSsh(this.servers.target(initial.serverId)));
    } catch (err: any) {
      finish({ status: "failed", error: err?.message ?? String(err) });
      return;
    }

    const timer = setInterval(() => {
      try {
        flush();
      } catch (err: any) {
        this.logError(`Output of deployment ${id} not saved: ${err?.message ?? err}`);
      }
    }, FLUSH_MS);

    try {
      const channel = await openExec(client, "sh -s");
      const trace = new TraceReader((line) => {
        currentLine = line;
        dirty = true;
      });
      this.running.set(id, { client, channel, trace });
      if (this.deployments.get(id).cancelRequested) channel.close();

      const stdout = new StringDecoder("utf8");
      const stderr = new StringDecoder("utf8");
      const append = (text: string) => {
        const next = appendOutput(output, text);
        output = next.output;
        truncated = truncated || next.truncated;
        dirty = true;
      };
      channel.on("data", (chunk: Buffer) => append(stdout.write(chunk)));
      channel.stderr.on("data", (chunk: Buffer) => trace.push(stderr.write(chunk)));

      const exitCode = await new Promise<number | null>((resolve) => {
        let code: number | null = null;
        channel.on("exit", (exit: number | null) => (code = typeof exit === "number" ? exit : null));
        channel.on("close", () => resolve(code));
        channel.end(remoteWrapper(initial.script, { BRANCH: initial.branch, COMMIT: initial.commit ?? "", REPO: initial.repoId }));
      });
      append(stdout.end());
      trace.push(`${stderr.end()}\n`);

      if (exitCode === 0) finish({ status: "done", exitCode });
      else if (exitCode === null) finish({ status: "failed", exitCode, error: "Le script s'est arrêté sans code de sortie : connexion coupée ou processus tué." });
      else finish({ status: "failed", exitCode, error: `Le script s'est arrêté avec le code ${exitCode}${currentLine !== null ? `, à la ligne ${currentLine}` : ""}.` });
    } catch (err: any) {
      finish({ status: "failed", error: err?.message ?? String(err) });
    } finally {
      clearInterval(timer);
      client.end();
    }
  }
}
