import { spawn } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { CommandAbortedError, killTree } from "./commands.js";
import { TrackerError } from "./errors.js";

/**
 * Sessions Claude Code non interactives (`claude -p`, sortie `stream-json`).
 * Claude Code s'authentifie par un token d'abonnement (`claude setup-token`)
 * passé dans CLAUDE_CODE_OAUTH_TOKEN et garde sa configuration dans un dossier
 * propre au tracker. Il ne reçoit aucune autre variable du serveur : ni
 * GITHUB_TOKEN, ni les réglages du tracker. Seuls les réglages du dossier de
 * configuration sont lus, jamais ceux du dossier de travail.
 */

export interface ClaudeRuntime {
  /** Commande de Claude Code et ses arguments fixes. */
  command: string[];
  /** Dossier personnel et de configuration de Claude Code. */
  home: string;
}

/** Commande du paquet `@anthropic-ai/claude-code` : son lanceur Node, qui exécute le binaire natif de la plateforme. */
export function packagedClaudeCommand(): string[] {
  const require = createRequire(import.meta.url);
  return [process.execPath, require.resolve("@anthropic-ai/claude-code/cli-wrapper.cjs")];
}

/** Variables du serveur transmises à Claude Code : chemins système et langue, aucun secret. */
const PASSED_ENV = ["PATH", "LANG", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA"];

function sessionEnv(runtime: ClaudeRuntime, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: runtime.home, CLAUDE_CONFIG_DIR: runtime.home, CLAUDE_CODE_OAUTH_TOKEN: token };
  for (const name of PASSED_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export interface ClaudeSessionOptions {
  /** Dossier de travail : le seul que Claude Code lit sans autorisation. */
  cwd: string;
  prompt: string;
  /** Options propres à la session : outils, configuration MCP, schéma du résultat. */
  args: string[];
  token: string;
  maxTurns: number;
  maxMinutes: number;
  signal?: AbortSignal;
  /** Reçoit chaque action lisible de Claude (texte ou appel d'outil) et le nombre de tours écoulés. */
  onLine?: (line: string, turns: number) => void;
}

export interface ClaudeSessionResult {
  /** Résultat validé par `--json-schema`, absent sans schéma. */
  structured: unknown;
  turns: number | null;
}

const MAX_LINE = 240;

function shorten(text: string): string {
  const first = text.trim().split(/\r?\n/)[0];
  return first.length > MAX_LINE ? `${first.slice(0, MAX_LINE)}…` : first;
}

/** Appel d'outil en clair : `Read src/app.ts`, `Grep mermaid`, `organizer create_task`. */
function describeTool(name: string, input: any, cwd: string): string {
  const relative = (file: unknown) => (typeof file === "string" && path.isAbsolute(file) ? path.relative(cwd, file) || "." : String(file ?? ""));
  if (name === "Read") return `Read ${relative(input?.file_path)}`;
  if (name === "Grep") return `Grep ${input?.pattern ?? ""}${input?.path ? ` in ${relative(input.path)}` : ""}`;
  if (name === "Glob") return `Glob ${input?.pattern ?? ""}`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} ${mcp[2]}`;
  return name;
}

/** Lecture de la sortie `stream-json` : une ligne JSON par évènement, du texte brut pour les messages de Claude Code lui-même. */
class StreamReader {
  turns = 0;
  result: any = null;
  lastText: string | null = null;
  private readonly messages = new Set<string>();
  private readonly pending = new Map<"stdout" | "stderr", string>();

  constructor(private readonly cwd: string) {}

  feed(source: "stdout" | "stderr", chunk: string): string[] {
    const text = (this.pending.get(source) ?? "") + chunk;
    const lines = text.split(/\r?\n/);
    this.pending.set(source, lines.pop() ?? "");
    return lines.flatMap((line) => this.line(line));
  }

  flush(): string[] {
    const rest = [...this.pending.values()];
    this.pending.clear();
    return rest.flatMap((line) => this.line(line));
  }

  private line(raw: string): string[] {
    const line = raw.trim();
    if (line === "") return [];
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      this.lastText = shorten(line);
      return [this.lastText];
    }
    if (event?.type === "assistant") return this.assistant(event.message ?? {});
    if (event?.type === "result") {
      this.result = event;
      if (typeof event.result === "string" && event.result.trim()) this.lastText = shorten(event.result);
    }
    return [];
  }

  private assistant(message: any): string[] {
    if (typeof message.id === "string" && !this.messages.has(message.id)) {
      this.messages.add(message.id);
      this.turns += 1;
    }
    const lines: string[] = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.lastText = shorten(block.text);
        lines.push(this.lastText);
      } else if (block?.type === "tool_use" && typeof block.name === "string") {
        lines.push(describeTool(block.name, block.input, this.cwd));
      }
    }
    return lines;
  }
}

/**
 * Lance une session et attend sa fin. Les tours sont limités par Claude Code,
 * la durée par le tracker, qui tue alors la session avec ses descendants, comme
 * à l'annulation par `signal`. Une session qui n'aboutit pas lève une erreur
 * avec sa raison ; une annulation lève `CommandAbortedError`.
 */
export function runClaudeSession(runtime: ClaudeRuntime, options: ClaudeSessionOptions): Promise<ClaudeSessionResult> {
  if (options.signal?.aborted) return Promise.reject(new CommandAbortedError());
  fs.mkdirSync(runtime.home, { recursive: true, mode: 0o700 });
  const [command, ...fixed] = runtime.command;
  const args = [
    ...fixed,
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(options.maxTurns),
    "--setting-sources",
    "user",
    "--permission-mode",
    "dontAsk",
    ...options.args,
  ];
  const reader = new StreamReader(options.cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sessionEnv(runtime, options.token),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    const stop = () => {
      if (child.pid !== undefined && child.exitCode === null) killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.maxMinutes * 60_000);
    options.signal?.addEventListener("abort", stop);
    const emit = (lines: string[]) => {
      for (const line of lines) options.onLine?.(line, reader.turns);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      fn();
    };

    child.stdout.on("data", (chunk) => emit(reader.feed("stdout", String(chunk))));
    child.stderr.on("data", (chunk) => emit(reader.feed("stderr", String(chunk))));
    child.on("error", (err) => finish(() => reject(new TrackerError(`Cannot start Claude Code: ${err.message}`))));
    child.on("close", (code) => {
      emit(reader.flush());
      finish(() => {
        const result = reader.result;
        if (options.signal?.aborted) return reject(new CommandAbortedError());
        if (timedOut) return reject(new TrackerError(`Claude Code was stopped after ${options.maxMinutes} min.`));
        if (result?.subtype === "error_max_turns") return reject(new TrackerError(`Claude Code reached the limit of ${options.maxTurns} turns.`));
        if (code !== 0 || !result || result.is_error === true) {
          return reject(new TrackerError(`Claude Code stopped (exit code ${code})${reader.lastText ? `: ${reader.lastText}` : "."}`));
        }
        resolve({ structured: result.structured_output, turns: typeof result.num_turns === "number" ? result.num_turns : null });
      });
    });
  });
}

/** Vérifie un token d'abonnement par une requête minimale ; lève une erreur avec la réponse de Claude Code s'il est refusé. */
export async function checkClaudeToken(runtime: ClaudeRuntime, token: string): Promise<void> {
  try {
    await runClaudeSession(runtime, {
      cwd: runtime.home,
      prompt: "Reply with OK.",
      args: ["--tools", "", "--model", "haiku"],
      token,
      maxTurns: 1,
      maxMinutes: 2,
    });
  } catch (err: any) {
    throw new TrackerError(`The Claude token was refused: ${err?.message ?? err}`);
  }
}
