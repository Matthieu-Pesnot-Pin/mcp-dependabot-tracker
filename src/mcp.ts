import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseServerUrl } from "./cli/setup-mcp.js";
import { AgentClient } from "./tools/client.js";
import { TOOLS, callTool } from "./tools/tools.js";
import { errorResult } from "./tools/types.js";
import { APP_VERSION } from "./version.js";

/** Présentation transmise au client MCP : concepts, déroulé et règles. */
const INSTRUCTIONS = `mcp-dependabot-tracker follows the Dependabot alerts of GitHub repositories and fixes their npm vulnerabilities. These tools drive a Dependabot Tracker server, the same one the user drives from its web GUI: you start audits and fixes as the user would, and the server runs them. You never run git or npm yourself.

Concepts:
- A **tracked repository** is a GitHub repository the user added in the GUI. Its open Dependabot alerts, and the pull requests the tracker opened that are not merged or closed yet, are read from GitHub and refreshed every 10 minutes.
- A **deprecated repository** is one the user set aside in the GUI: list_repositories leaves it out, and every tool refuses it until the user restores it.
- The **scope** of an audit or a fix is chosen at each launch: production (the default) runs npm audit and npm audit fix with --omit=dev, so the devDependencies are left out; all covers every dependency.
- The **analysed branch** of a repository is chosen by the user in the GUI (the default branch unless changed). Dependabot alerts always describe the default branch; npm audit describes the analysed branch.
- An **operation** is an audit or a fix, run by the server in a temporary clone of the analysed branch, deleted at the end. A fix runs npm audit fix with --package-lock-only and --ignore-scripts, then, when vulnerabilities remain, the fixes by Claude (unless you pass claude: false), then commits on a new branch fix/npm-audit-<date>-<time> and opens a pull request to the analysed branch.

Workflow:
1. list_repositories to see the tracked repositories and their open alerts.
2. get_alerts for the detail of the alerts of one repository.
3. run_audit to see what npm audit reports, or fix_vulnerabilities to fix, on the production dependencies unless the user asks for all of them. Both return at once with the id of the operation.
4. get_operation to follow the operation until it is done, failed or cancelled; cancel_operation to stop it.

Rules:
- One operation at a time per repository.`;

/** Lit une variable obligatoire du mode MCP ; arrête le processus si elle manque. */
function required(name: string, purpose: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(`${name} is not set: declare ${purpose} in the env block of mcp-dependabot-tracker.\n`);
    process.exit(1);
  }
  return value;
}

/**
 * Mode MCP, lancé par un agent : expose sur stdio les outils qui pilotent le
 * serveur Dependabot Tracker de SERVER_URL, avec le token d'agent AGENT_TOKEN.
 * Il ne fait aucun travail lui-même.
 */
export async function runMcp(): Promise<void> {
  const url = parseServerUrl(required("SERVER_URL", "the address of the Dependabot Tracker server"), "SERVER_URL");
  if ("error" in url) {
    process.stderr.write(`${url.error}\n`);
    process.exit(1);
  }
  const client = new AgentClient(url.url, required("AGENT_TOKEN", "an agent token, created in the settings of the server GUI"));

  const server = new Server({ name: "mcp-dependabot-tracker", version: APP_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      return await callTool(client, request.params.name, request.params.arguments);
    } catch (err: any) {
      return errorResult(err?.message ?? String(err));
    }
  });
  await server.connect(new StdioServerTransport());
}
