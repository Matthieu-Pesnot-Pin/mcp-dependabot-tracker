import fs from "node:fs";
import path from "node:path";

/**
 * Faux Claude Code : il note chaque appel dans `<CLAUDE_CONFIG_DIR>/calls.jsonl`
 * (arguments, dossier de travail, variables reçues) et répond en `stream-json`.
 * Le token reçu choisit la réponse :
 *   `refused`  session en erreur, comme un token invalide ;
 *   `untagged` tâche créée et assignée, sans tag ;
 *   `slow`     session qui ne se termine pas d'elle-même ;
 *   tout autre token : tâche créée, assignée et taguée selon la consigne.
 * Avec `--mcp-config`, il appelle le faux organizer avec l'adresse et le token
 * de la configuration ; sans, il répond simplement.
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
  JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env), home: process.env.HOME, token }) + "\n"
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

  const server = JSON.parse(fs.readFileSync(configFile, "utf-8")).mcpServers.organizer;
  const { ORGANIZER_URL: url, ORGANIZER_TOKEN: organizerToken } = server.env;
  const prompt = option("-p") ?? "";
  const ownerId = /member id ([^)\s]+)\)/.exec(prompt)?.[1] ?? "";
  const tag = /set its tags to exactly \["([^"]+)"\]/.exec(prompt)?.[1] ?? "";

  emit({ type: "assistant", message: { id: "m-1", content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(process.cwd(), "package.json") } }] } });
  emit({ type: "assistant", message: { id: "m-2", content: [{ type: "text", text: "nth-check sert à css-select ; la montée majeure est sans risque." }] } });
  const { task } = await call(url, organizerToken, "POST", "tasks", { title: "Monter nth-check en v3", description: "Rapport" });
  emit({ type: "assistant", message: { id: "m-3", content: [{ type: "tool_use", name: "mcp__organizer__create_task", input: {} }] } });
  await call(url, organizerToken, "PUT", `tasks/${task.key}/assignees`, { assignees: [ownerId] });
  if (token !== "untagged") await call(url, organizerToken, "PUT", `tasks/${task.key}/tags`, { tags: [tag] });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    result: "done",
    structured_output: {
      task: task.key,
      summary: "nth-check n'est utilisé qu'à la compilation.",
      urgent: [],
      force: { recommended: true, reason: "La v3 garde l'API utilisée." },
    },
  });
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
});
