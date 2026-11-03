import fs from "node:fs";
import path from "node:path";

/**
 * Faux Claude Code : il note chaque appel dans `<CLAUDE_CONFIG_DIR>/calls.jsonl`
 * (arguments, dossier de travail, variables reçues) et répond en `stream-json`.
 * Le token reçu choisit la réponse :
 *   `refused`  session en erreur, comme un token invalide ;
 *   `untagged` tâche créée et assignée, sans tag ;
 *   `slow`     session qui ne se termine pas d'elle-même ;
 *   `broken`   corrections qui modifient le clone puis échouent ;
 *   tout autre token : tâche créée, assignée et taguée selon la consigne.
 * Avec `--mcp-config`, il appelle le faux organizer avec l'adresse et le token
 * de la configuration ; sans, il répond simplement. Une consigne de corrections
 * lit les remarques de la tâche de l'analyse, écrit `src/fixed.js` et un
 * fichier dans `node_modules`, puis crée la sous-tâche du rapport, ou reprend
 * celle du passage précédent.
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
  if (prompt.startsWith("You fix the npm vulnerabilities")) return repair(url, organizerToken, prompt, ownerId, tag);

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

async function repair(url: string, organizerToken: string, prompt: string, ownerId: string, tag: string) {
  const analysisTask = /Read the organizer task (\S+) with get_task/.exec(prompt)?.[1] ?? "";
  const previous = /your previous report, task ([^\s,]+), with update_task/.exec(prompt)?.[1] ?? null;
  const { comments } = await call(url, organizerToken, "GET", `tasks/${analysisTask}`);
  const remarks = comments.map((comment: { body: string }) => comment.body);
  emit({ type: "assistant", message: { id: "m-1", content: [{ type: "tool_use", name: "mcp__organizer__get_task", input: {} }] } });
  fs.mkdirSync("src", { recursive: true });
  fs.writeFileSync(path.join("src", "fixed.js"), `// ${remarks.join(" / ")}\n`);
  fs.mkdirSync("node_modules", { recursive: true });
  fs.writeFileSync(path.join("node_modules", "installed.txt"), "installed by npm ci\n");
  emit({ type: "assistant", message: { id: "m-2", content: [{ type: "tool_use", name: "Edit", input: {} }] } });
  if (token === "broken") {
    emit({ type: "result", subtype: "success", is_error: true, result: "The tests could not start", num_turns: 2 });
    process.exit(1);
  }
  let key = previous;
  if (!key) {
    ({ task: { key } } = await call(url, organizerToken, "POST", "tasks", { title: "Rapport de développement — correctifs", description: "Rapport", parent: analysisTask }));
    await call(url, organizerToken, "PUT", `tasks/${key}/assignees`, { assignees: [ownerId] });
    await call(url, organizerToken, "PUT", `tasks/${key}/tags`, { tags: [tag] });
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    result: "done",
    structured_output: {
      task: key,
      summary: `${remarks.length} remarque(s) prise(s) en compte.`,
      changes: [{ file: "src/fixed.js", change: "correctif appliqué" }],
      commitMessage: "fix(deps): apply the fixes by Claude",
      tests: { outcome: "passed", detail: "Les tests passent." },
    },
  });
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
});
