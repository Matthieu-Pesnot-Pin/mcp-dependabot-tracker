import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Faux Claude Code : il note chaque appel dans `<CLAUDE_CONFIG_DIR>/calls.jsonl`
 * (arguments, dossier de travail, variables reçues) et répond en `stream-json`.
 * Le token reçu choisit la réponse :
 *   `refused`  session en erreur, comme un token invalide ;
 *   `untagged` tâche créée et assignée, sans tag ;
 *   `slow`     session qui ne se termine pas d'elle-même ;
 *   `broken`   corrections qui modifient le clone puis échouent ;
 *   `idle`     corrections qui ne modifient rien ;
 *   `red`      corrections dont les tests échouent ;
 *   tout autre token : tâche créée, assignée et taguée selon la consigne.
 * Avec `--mcp-config`, il écrit `src/fixed.js`, un fichier dans
 * `node_modules` et un hook `.git/hooks/pre-commit` qui crée
 * `<CLAUDE_CONFIG_DIR>/hook-ran.txt`, appelle l'outil `npm_ls` du serveur `npm` de la
 * configuration et note sa réponse dans `<CLAUDE_CONFIG_DIR>/npm-tools.txt`,
 * puis crée la tâche du rapport sur le faux organizer, avec l'adresse et le
 * token de la configuration ; sans, il répond simplement.
 */

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const home = process.env.CLAUDE_CONFIG_DIR ?? process.cwd();

fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(
  path.join(home, "calls.jsonl"),
  JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env), home: process.env.HOME, token, gitInCwd: fs.existsSync(".git") }) + "\n"
);

const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");

async function call(url: string, organizerToken: string, method: string, route: string, body?: unknown): Promise<any> {
  const response = await fetch(`${url}/api/agent/${route}`, {
    method,
    headers: { authorization: `Bearer ${organizerToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()).data;
}

async function main() {
  if (token === "refused") {
    emit({ type: "result", subtype: "success", is_error: true, result: "Invalid bearer token", num_turns: 0 });
    process.exit(1);
  }
  if (token === "slow") {
    emit({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Je lis le code…" }] } });
    setInterval(() => {}, 1000);
    return;
  }
  const configFile = option("--mcp-config");
  if (!configFile) {
    emit({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
    return;
  }

  const servers = JSON.parse(fs.readFileSync(configFile, "utf-8")).mcpServers;
  const { ORGANIZER_URL: url, ORGANIZER_TOKEN: organizerToken } = servers.organizer.env;
  const prompt = option("-p") ?? "";
  const ownerId = /member id ([^)\s]+)\)/.exec(prompt)?.[1] ?? "";
  const tag = /set its tags to exactly \["([^"]+)"\]/.exec(prompt)?.[1] ?? "";
  await repair(url, organizerToken, ownerId, tag, servers.npm);
}

/** Appelle un outil d'un serveur MCP stdio de la configuration et rend le texte de sa réponse. */
async function callMcpTool(server: { command: string; args: string[] }, name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args }));
  try {
    const result: any = await client.callTool({ name, arguments: args });
    return result.content.map((block: { text: string }) => block.text).join("\n");
  } finally {
    await client.close();
  }
}

async function repair(url: string, organizerToken: string, ownerId: string, tag: string, npm: { command: string; args: string[] }) {
  emit({ type: "assistant", message: { id: "m-1", content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(process.cwd(), "package.json") } }] } });
  emit({ type: "assistant", message: { id: "m-2", content: [{ type: "text", text: "nth-check sert à css-select ; je le monte en v3." }] } });
  if (token !== "idle") {
    fs.mkdirSync("src", { recursive: true });
    fs.writeFileSync(path.join("src", "fixed.js"), "// correctif\n");
  }
  fs.mkdirSync("node_modules", { recursive: true });
  fs.writeFileSync(path.join("node_modules", "installed.txt"), "installed by npm ci\n");
  fs.mkdirSync(path.join(".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${path.join(home, "hook-ran.txt").replace(/\\/g, "/")}"\n`, { mode: 0o755 });
  emit({ type: "assistant", message: { id: "m-3", content: [{ type: "tool_use", name: "Edit", input: {} }] } });
  fs.writeFileSync(path.join(home, "npm-tools.txt"), await callMcpTool(npm, "npm_ls", { project: "", package: "lodash" }));
  if (token === "broken") {
    emit({ type: "result", subtype: "success", is_error: true, result: "The tests could not start", num_turns: 2 });
    process.exit(1);
  }
  const { task } = await call(url, organizerToken, "POST", "tasks", { title: "Rapport de correction — nth-check en v3", description: "Rapport" });
  emit({ type: "assistant", message: { id: "m-4", content: [{ type: "tool_use", name: "mcp__organizer__create_task", input: {} }] } });
  await call(url, organizerToken, "PUT", `tasks/${task.key}/assignees`, { assignees: [ownerId] });
  if (token !== "untagged") await call(url, organizerToken, "PUT", `tasks/${task.key}/tags`, { tags: [tag] });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    result: "done",
    structured_output: {
      task: task.key,
      summary: "nth-check monté en v3.",
      changes: token === "idle" ? [] : [{ file: "src/fixed.js", change: "correctif appliqué" }],
      commitMessage: "fix(deps): apply the fixes by Claude",
      tests: token === "red" ? { outcome: "failed", detail: "Deux tests échouent." } : { outcome: "passed", detail: "Les tests passent." },
    },
  });
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
});
