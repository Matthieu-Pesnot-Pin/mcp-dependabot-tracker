#!/usr/bin/env node

/**
 * Point d'entrée du paquet :
 *   serve                                          le serveur Dependabot Tracker (interface, API, opérations) ;
 *   mcp                                            le mode MCP, lancé par un agent, qui pilote un serveur ;
 *   user add|password|remove|list                  gère les comptes de l'interface ;
 *   --claude-setup-mcp --server_url=… --token=…    déclare le mode MCP dans le .mcp.json du répertoire courant ;
 *   --generate-vault-key                           affiche une nouvelle VAULT_KEY ;
 *   --generate-auth-secret                         affiche un nouvel AUTH_SECRET.
 */

const { USERS_USAGE } = await import("./cli/users.js");

const USAGE = [
  "Usage :",
  "  mcp-dependabot-tracker serve                                         lance le serveur",
  "  mcp-dependabot-tracker mcp                                           mode MCP, lancé par un agent (SERVER_URL, AGENT_TOKEN)",
  USERS_USAGE,
  "  mcp-dependabot-tracker --claude-setup-mcp --server_url=<url> --token=<token> [--force]",
  "  mcp-dependabot-tracker --generate-vault-key                          affiche une nouvelle VAULT_KEY",
  "  mcp-dependabot-tracker --generate-auth-secret                        affiche un nouvel AUTH_SECRET",
].join("\n");

const argv = process.argv.slice(2);

if (argv.includes("--generate-vault-key")) {
  const { generateVaultKey } = await import("./core/vault.js");
  console.log(generateVaultKey());
} else if (argv.includes("--generate-auth-secret")) {
  const { generateAuthSecret } = await import("./core/auth.js");
  console.log(generateAuthSecret());
} else if (argv.includes("--claude-setup-mcp")) {
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
} else if (argv[0] === "user") {
  const { loadPackageEnv } = await import("./server/serve.js");
  loadPackageEnv();
  const { runUsers } = await import("./cli/users.js");
  process.exit(await runUsers(argv.slice(1)));
} else if (argv[0] === "mcp") {
  const { runMcp } = await import("./mcp.js");
  await runMcp();
} else {
  console.error(USAGE);
  process.exit(1);
}
