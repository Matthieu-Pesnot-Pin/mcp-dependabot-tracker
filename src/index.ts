#!/usr/bin/env node

/**
 * Point d'entrée du paquet :
 *   serve                                          le serveur Dependabot Tracker (interface, API, opérations) ;
 *   mcp                                            le mode MCP, lancé par un agent, qui pilote un serveur ;
 *   --claude-setup-mcp --server_url=… --token=…    déclare le mode MCP dans le .mcp.json du répertoire courant.
 */

const USAGE = [
  "Usage :",
  "  mcp-dependabot-tracker serve                                         lance le serveur",
  "  mcp-dependabot-tracker mcp                                           mode MCP, lancé par un agent (SERVER_URL, AGENT_TOKEN)",
  "  mcp-dependabot-tracker --claude-setup-mcp --server_url=<url> --token=<token> [--force]",
].join("\n");

const argv = process.argv.slice(2);

if (argv.includes("--claude-setup-mcp")) {
  const { parseConnection, runSetupMcp } = await import("./cli/setup-mcp.js");
  const parsed = parseConnection(argv);
  if ("error" in parsed) {
    console.error(`Erreur : ${parsed.error}`);
    process.exit(1);
  }
  process.exit(runSetupMcp({ cwd: process.cwd(), force: argv.includes("--force"), connection: parsed.connection }));
} else if (argv[0] === "serve") {
  const { serve } = await import("./server/serve.js");
  await serve();
} else if (argv[0] === "mcp") {
  const { runMcp } = await import("./mcp.js");
  await runMcp();
} else {
  console.error(USAGE);
  process.exit(1);
}
