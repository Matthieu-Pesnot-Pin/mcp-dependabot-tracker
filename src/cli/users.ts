import readline from "readline";

import { addUser, createAuth, listUsers, migrateAuth, removeUser, setUserPassword, type Auth } from "../core/auth.js";
import { resolveDataDir } from "../core/data-dir.js";
import { readAuthEnv } from "../core/server-config.js";

export const USERS_USAGE = [
  "  mcp-dependabot-tracker user add <email> [--name=<nom>]               crée un compte (mot de passe demandé)",
  "  mcp-dependabot-tracker user password <email>                         change le mot de passe et ferme les sessions",
  "  mcp-dependabot-tracker user remove <email>                           supprime le compte",
  "  mcp-dependabot-tracker user list                                     liste les comptes",
].join("\n");

/** Lit une ligne sur le terminal sans l'afficher. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    output._writeToOutput = (text: string) => {
      if (!muted || text.includes("\n")) output.output.write(muted ? "\n" : text);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/** Lignes de l'entrée standard quand elle n'est pas un terminal. */
async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

/**
 * Nouveau mot de passe : saisi deux fois sur un terminal, ou lu sur la
 * première ligne de l'entrée standard sinon.
 */
async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const [first] = await readStdinLines();
    return first ?? "";
  }
  const password = await promptHidden("Mot de passe : ");
  const confirmation = await promptHidden("Confirmation : ");
  if (password !== confirmation) throw new Error("Les deux saisies diffèrent.");
  return password;
}

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function requireEmail(args: string[], usage: string): string {
  const email = args.find((arg) => !arg.startsWith("--"));
  if (!email) throw new Error(`Adresse e-mail manquante : ${usage}`);
  return email;
}

async function openAuth(): Promise<Auth> {
  const auth = createAuth(resolveDataDir(), readAuthEnv());
  await migrateAuth(auth);
  return auth;
}

/** Exécute `user <action> …` ; rend le code de sortie. */
export async function runUsers(argv: string[]): Promise<number> {
  const [action, ...args] = argv;
  try {
    if (action === "add") {
      const email = requireEmail(args, "user add <email> [--name=<nom>]");
      const auth = await openAuth();
      const password = await readNewPassword();
      const user = await addUser(auth, { email, name: readFlag(args, "name") ?? "", password });
      console.log(`Compte créé : ${user.email}`);
      return 0;
    }
    if (action === "password") {
      const email = requireEmail(args, "user password <email>");
      const auth = await openAuth();
      await setUserPassword(auth, email, await readNewPassword());
      console.log(`Mot de passe changé pour ${email} ; ses sessions sont fermées.`);
      return 0;
    }
    if (action === "remove") {
      const email = requireEmail(args, "user remove <email>");
      await removeUser(await openAuth(), email);
      console.log(`Compte supprimé : ${email}`);
      return 0;
    }
    if (action === "list") {
      const users = await listUsers(await openAuth());
      if (users.length === 0) console.log("Aucun compte.");
      for (const user of users) console.log(`${user.email}\t${user.name}\t${user.createdAt.toISOString()}`);
      return 0;
    }
    console.error(`Usage :\n${USERS_USAGE}`);
    return 1;
  } catch (err: any) {
    console.error(`Erreur : ${err?.message ?? err}`);
    return 1;
  }
}
