import crypto from "crypto";
import fs from "fs";
import path from "path";
import ssh2, { type Client } from "ssh2";
import {
  DeployServersFileSchema,
  type DeployServer,
  type DeployServerBody,
  type DeployServersFile,
  type DeployServerView,
  type KeyFileStatus,
  type StoredDeployServer,
  type TestDeployServerResponse,
} from "../../shared/schemas/deploy.schema.js";
import { NotFoundError, TrackerError } from "./errors.js";
import { connectSsh, execScript, type SshTarget } from "./ssh.js";
import { decryptSecret, encryptSecret } from "./vault.js";

/** Fichier de clés propre au tracker, relatif au dossier personnel de l'utilisateur distant. */
export const DEDICATED_KEY_FILE = ".ssh/authorized_keys.d/dependabot-tracker";

/** Réglage sshd qui ajoute le fichier dédié à ~/.ssh/authorized_keys. */
export const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/10-dependabot-tracker.conf";

/**
 * Fichiers de clés lus par sshd. Celui de SSH Gate y figure : sshd ne retient
 * que le premier AuthorizedKeysFile rencontré, et ce réglage, lu avant celui de
 * SSH Gate, ne doit pas lui retirer son accès sur un serveur où les deux sont installés.
 */
const SSHD_SETTING = `AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.d/ssh-gate ${DEDICATED_KEY_FILE}`;

const KEY_FILE = `"$HOME/${DEDICATED_KEY_FILE}"`;
const ADDRESS = /^[0-9a-f.:]+$/i;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/i;
const HOST_PATTERN = /^[a-z0-9.:\-\[\]]+$/i;

/** Ligne du fichier dédié : `restrict` coupe redirections, agent, X11 et pseudo-terminal ; `from` limite la clé à l'adresse du tracker. */
export function keyLine(publicKey: string, allowedFrom: string | null = null): string {
  return `restrict${allowedFrom ? `,from="${allowedFrom}"` : ""} ${publicKey.trim()}`;
}

/**
 * Commande d'installation, sur une ligne : écrit la clé dans le fichier dédié,
 * fait lire ce fichier à sshd en plus de ~/.ssh/authorized_keys, et ne recharge
 * sshd que si la configuration est valide et prend bien le fichier dédié en
 * compte ; sinon le réglage ajouté est retiré. Le service s'appelle `ssh` sur
 * Debian et Ubuntu, `sshd` ailleurs ; `try-reload-or-restart` ne fait rien quand
 * il est arrêté, cas de l'activation par socket où sshd lit sa configuration au
 * démarrage.
 */
export function installCommand(publicKey: string): string {
  const dir = "~/.ssh/authorized_keys.d";
  const file = `~/${DEDICATED_KEY_FILE}`;
  return [
    `mkdir -p ${dir}`,
    `chmod 700 ~/.ssh ${dir}`,
    `printf '%s\\n' '${keyLine(publicKey)}' > ${file}`,
    `chmod 600 ${file}`,
    `printf '%s\\n' '${SSHD_SETTING}' | sudo tee ${SSHD_DROP_IN} > /dev/null`,
    `if sudo sshd -t && sudo sshd -T -C user=$(id -un),host=localhost,addr=127.0.0.1 | grep -q 'authorized_keys.d/dependabot-tracker'; ` +
      `then unit=sshd; [ "$(systemctl show -p LoadState --value ssh.service)" = loaded ] && unit=ssh; ` +
      `sudo systemctl try-reload-or-restart "$unit.service" && echo 'Dependabot Tracker : installation terminée'; ` +
      `else sudo rm -f ${SSHD_DROP_IN}; echo 'Dependabot Tracker : sshd ne prend pas le fichier dédié en compte, réglage retiré'; fi`,
  ].join(" && ");
}

/** Contrôle et normalise les champs saisis pour un serveur. */
export function validateServerInput(input: DeployServerBody): DeployServerBody {
  const name = String(input.name ?? "").trim();
  const host = String(input.host ?? "").trim();
  const username = String(input.username ?? "").trim();
  const port = Number(input.port);

  if (!name) throw new TrackerError("Le nom du serveur est obligatoire.");
  if (name.length > 60) throw new TrackerError("Le nom du serveur dépasse 60 caractères.");
  if (!host) throw new TrackerError("L'hôte est obligatoire.");
  if (!HOST_PATTERN.test(host)) throw new TrackerError(`Hôte invalide : « ${host} ».`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TrackerError("Le port doit être un entier entre 1 et 65535.");
  if (!username) throw new TrackerError("L'utilisateur est obligatoire.");
  if (!USERNAME_PATTERN.test(username)) throw new TrackerError(`Utilisateur invalide : « ${username} ».`);
  return { name, host, port, username };
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "serveur";
}

/** Nouvelle paire ed25519, commentée au nom du serveur. */
function generateKeyPair(serverId: string): { public: string; private: string } {
  const keys = ssh2.utils.generateKeyPairSync("ed25519", { comment: `dependabot-tracker@${serverId}` });
  return { public: keys.public, private: keys.private };
}

function toPublic({ privateKeyEncrypted: _key, ...server }: StoredDeployServer): DeployServer {
  return server;
}

/** Type et corps de la clé, sans le commentaire : ce qui identifie la clé dans un fichier. */
function keyIdentity(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

function allowedFromOf(line: string): string | null {
  const options = line.split(/\s+/)[0];
  return /(?:^|,)from="([^"]*)"/.exec(options)?.[1] ?? null;
}

interface Inspection {
  /** Ligne du fichier dédié qui porte la clé, ou null. */
  line: string | null;
  inAuthorizedKeys: boolean;
  /** Adresse du tracker vue par le serveur (`$SSH_CLIENT`). */
  clientAddress: string | null;
}

async function inspect(client: Client, publicKey: string): Promise<Inspection> {
  const identity = keyIdentity(publicKey);
  const script = [
    `F=${KEY_FILE}`,
    `A="$HOME/.ssh/authorized_keys"`,
    `line=""`,
    `[ -f "$F" ] && line=$(grep -F '${identity}' "$F" | head -n 1)`,
    `auth=0`,
    `[ -f "$A" ] && grep -qF '${identity}' "$A" && auth=1`,
    `set -- $SSH_CLIENT`,
    `printf 'client=%s\\nauthorized=%s\\nline=%s\\n' "$1" "$auth" "$line"`,
    ``,
  ].join("\n");
  const { code, output } = await execScript(client, script);
  if (code !== 0) throw new TrackerError(`Lecture des fichiers de clés impossible : ${output.trim() || `code ${code}`}`);
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(output)?.[1].trim() ?? "";
  return { line: field("line") || null, inAuthorizedKeys: field("authorized") === "1", clientAddress: field("client") || null };
}

/**
 * Remplace la ligne de la clé `publicKey` du fichier dédié par `line`, sans
 * toucher aux lignes des autres clés, par un fichier temporaire renommé :
 * jamais de fichier à moitié écrit.
 */
async function writeKeyLine(client: Client, publicKey: string, line: string): Promise<void> {
  const script = [
    `umask 077`,
    `mkdir -p "$HOME/.ssh/authorized_keys.d"`,
    `{ [ -f ${KEY_FILE} ] && grep -vF '${keyIdentity(publicKey)}' ${KEY_FILE}; cat <<'DEPENDABOT_TRACKER_KEYS'`,
    line,
    `DEPENDABOT_TRACKER_KEYS`,
    `} > ${KEY_FILE}.tmp`,
    `mv -f ${KEY_FILE}.tmp ${KEY_FILE}`,
    ``,
  ].join("\n");
  const { code, output } = await execScript(client, script);
  if (code !== 0) throw new TrackerError(`Écriture de ~/${DEDICATED_KEY_FILE} impossible : ${output.trim() || `code ${code}`}`);
}

/** Écriture atomique d'un fichier lisible par le seul compte du serveur. */
function writePrivateJson(target: string, value: unknown): void {
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Serveurs de déploiement : `<données>/deploy-servers.json`, lisible par le
 * seul compte du serveur. La paire de clés est générée à la création ; seule la
 * clé publique est lisible, la clé privée est chiffrée avec VAULT_KEY.
 */
export class DeployServerStore {
  private readonly file: string;

  constructor(dataDir: string, private readonly vaultKey: Buffer) {
    this.file = path.join(dataDir, "deploy-servers.json");
  }

  private read(): DeployServersFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return { servers: [] };
      throw err;
    }
    const parsed = DeployServersFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new TrackerError(`${this.file} is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  private mutate<T>(fn: (servers: StoredDeployServer[]) => T): T {
    const { servers } = this.read();
    const result = fn(servers);
    writePrivateJson(this.file, DeployServersFileSchema.parse({ servers }));
    return result;
  }

  private find(servers: StoredDeployServer[], id: string): StoredDeployServer {
    const server = servers.find((candidate) => candidate.id === id);
    if (!server) throw new NotFoundError(`Deployment server "${id}" does not exist.`);
    return server;
  }

  view(server: DeployServer): DeployServerView {
    return { server, installCommand: installCommand(server.publicKey) };
  }

  list(): DeployServer[] {
    return this.read().servers.map(toPublic);
  }

  get(id: string): DeployServer {
    return toPublic(this.find(this.read().servers, id));
  }

  create(input: DeployServerBody): DeployServer {
    const fields = validateServerInput(input);
    return this.mutate((servers) => {
      const base = slugify(fields.name);
      let id = base;
      for (let n = 2; servers.some((server) => server.id === id); n += 1) id = `${base}-${n}`;
      const keys = generateKeyPair(id);
      const server: StoredDeployServer = {
        id,
        ...fields,
        publicKey: keys.public,
        allowedFrom: null,
        hostKeyFingerprint: null,
        createdAt: new Date().toISOString(),
        testedAt: null,
        privateKeyEncrypted: encryptSecret(keys.private, this.vaultKey),
      };
      servers.push(server);
      return toPublic(server);
    });
  }

  /** Modifie les champs saisis. Un changement d'hôte ou de port oublie l'empreinte et le test : c'est une autre machine. */
  update(id: string, input: DeployServerBody): DeployServer {
    const fields = validateServerInput(input);
    return this.mutate((servers) => {
      const server = this.find(servers, id);
      if (server.host !== fields.host || server.port !== fields.port) {
        server.hostKeyFingerprint = null;
        server.testedAt = null;
      }
      if (server.username !== fields.username) server.testedAt = null;
      Object.assign(server, fields);
      return toPublic(server);
    });
  }

  private patch(id: string, fields: Partial<DeployServer>): DeployServer {
    return this.mutate((servers) => {
      const server = this.find(servers, id);
      Object.assign(server, fields);
      return toPublic(server);
    });
  }

  /** Cible SSH du serveur, avec sa clé privée déchiffrée et l'empreinte enregistrée. */
  target(id: string): SshTarget {
    const server = this.find(this.read().servers, id);
    return {
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: decryptSecret(server.privateKeyEncrypted, this.vaultKey),
      expectedFingerprint: server.hostKeyFingerprint,
    };
  }

  /** Vérifie que VAULT_KEY déchiffre toutes les clés enregistrées. */
  verifyVault(): void {
    for (const server of this.read().servers) {
      try {
        decryptSecret(server.privateKeyEncrypted, this.vaultKey);
      } catch {
        throw new TrackerError(`VAULT_KEY does not decrypt the private key of the deployment server "${server.name}": it is not the key that was set when that server was added.`);
      }
    }
  }

  /**
   * Teste la connexion : enregistre l'empreinte de l'hôte au premier test, puis
   * limite la ligne de la clé à l'adresse du tracker vue par le serveur.
   */
  async test(id: string): Promise<TestDeployServerResponse> {
    const target = this.target(id);
    const { client, fingerprint } = await connectSsh(target);
    let cwd: string;
    try {
      const { code, output } = await execScript(client, "pwd\n");
      if (code !== 0) throw new TrackerError(`Le shell du serveur ne répond pas : ${output.trim() || `code ${code}`}`);
      cwd = output.trim();
    } finally {
      client.end();
    }
    this.patch(id, { hostKeyFingerprint: target.expectedFingerprint ?? fingerprint, testedAt: new Date().toISOString() });
    const keyFile = await this.restrictToTracker(id);
    return { server: this.view(this.get(id)), fingerprint, cwd, keyFile };
  }

  /**
   * Relève la place de la clé et limite sa ligne à l'adresse du tracker. La
   * nouvelle ligne est vérifiée par une seconde connexion, la première restant
   * ouverte pour remettre la ligne d'origine si le serveur la refuse.
   */
  private async restrictToTracker(id: string): Promise<KeyFileStatus> {
    const server = this.get(id);
    const target = this.target(id);
    const { client } = await connectSsh(target);
    try {
      const found = await inspect(client, server.publicKey);
      const status = (allowedFrom: string | null, restrictError: string | null): KeyFileStatus => {
        this.patch(id, { allowedFrom });
        return { inDedicatedFile: found.line !== null, inAuthorizedKeys: found.inAuthorizedKeys, allowedFrom, restrictError };
      };
      if (!found.line) return status(null, null);

      const current = allowedFromOf(found.line);
      const address = found.clientAddress && ADDRESS.test(found.clientAddress) ? found.clientAddress : null;
      if (!address) return status(current, "Le serveur n'indique pas l'adresse du tracker (SSH_CLIENT vide) : la limite d'adresse n'est pas posée.");

      const wanted = keyLine(server.publicKey, address);
      if (found.line === wanted) return status(address, null);

      await writeKeyLine(client, server.publicKey, wanted);
      try {
        const probe = await connectSsh(target);
        probe.client.end();
      } catch (err: any) {
        await writeKeyLine(client, server.publicKey, found.line);
        return status(current, `La limite à ${address} a été refusée par le serveur, la ligne d'origine est remise : ${err.message}`);
      }
      return status(address, null);
    } finally {
      client.end();
    }
  }
}
