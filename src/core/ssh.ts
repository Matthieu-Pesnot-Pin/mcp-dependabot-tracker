import { createHash } from "crypto";
import ssh2, { type Client, type ClientChannel } from "ssh2";
import { TrackerError } from "./errors.js";

const CONNECT_TIMEOUT_MS = 15_000;

/** Connexion SSH refusée à l'authentification : le serveur n'accepte pas la clé du tracker. */
export class AuthRefusedError extends TrackerError {
  constructor(message: string) {
    super(message);
    this.name = "AuthRefusedError";
  }
}

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** Empreinte attendue de la clé d'hôte ; null au premier test de connexion. */
  expectedFingerprint: string | null;
}

/** Empreinte au format d'OpenSSH : `SHA256:<base64 sans remplissage>`. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function connectionErrorMessage(err: any, target: SshTarget): string {
  if (err?.level === "client-authentication") {
    return `Authentification refusée pour ${target.username}@${target.host} : le serveur n'accepte pas la clé du tracker. Colle la commande d'installation sur le serveur, puis teste à nouveau.`;
  }
  if (err?.level === "client-timeout") return `Le serveur ${target.host}:${target.port} n'a pas répondu dans les ${CONNECT_TIMEOUT_MS / 1000} s.`;
  return `Connexion SSH impossible à ${target.host}:${target.port} : ${err?.message ?? err}`;
}

/**
 * Ouvre une connexion SSH authentifiée. Avec une empreinte attendue, une clé
 * d'hôte différente la fait échouer ; l'empreinte vue est renvoyée.
 */
export function connectSsh(target: SshTarget): Promise<{ client: Client; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let seenFingerprint: string | null = null;
    let settled = false;

    const fail = (message: string, authRefused = false) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(authRefused ? new AuthRefusedError(message) : new TrackerError(message));
    };

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve({ client, fingerprint: seenFingerprint! });
    });

    client.on("error", (err: any) => {
      if (target.expectedFingerprint && seenFingerprint && seenFingerprint !== target.expectedFingerprint) {
        return fail(
          `La clé d'hôte de ${target.host} a changé (${seenFingerprint}, attendue ${target.expectedFingerprint}). Connexion refusée : vérifie le serveur, puis modifie-le dans l'interface pour enregistrer la nouvelle empreinte.`
        );
      }
      fail(connectionErrorMessage(err, target), err?.level === "client-authentication");
    });

    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 30_000,
      hostVerifier: (key: Buffer) => {
        seenFingerprint = fingerprintOf(key);
        return target.expectedFingerprint === null || seenFingerprint === target.expectedFingerprint;
      },
    });
  });
}

/** Ouvre un canal qui exécute `command` sur le serveur. */
export function openExec(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => (err ? reject(new TrackerError(`Exécution impossible sur le serveur : ${err.message}`)) : resolve(channel)));
  });
}

/** Exécute un script sh transmis sur l'entrée standard ; renvoie son code de retour et sa sortie fusionnée. */
export async function execScript(client: Client, script: string): Promise<{ code: number | null; output: string }> {
  const channel = await openExec(client, "sh -s");
  return new Promise((resolve) => {
    let output = "";
    channel.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    channel.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    channel.on("close", (code: number | null) => resolve({ code, output }));
    channel.end(script);
  });
}
