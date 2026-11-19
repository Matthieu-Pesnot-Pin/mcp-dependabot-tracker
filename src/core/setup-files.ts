import path from "path";

/**
 * Fichiers et calculs de la commande `setup` : unité systemd, site nginx,
 * fichier `.env` et plage de sous-identifiants du compte de service.
 */

/** Nom du service systemd et du site nginx. */
export const SERVICE_NAME = "dependabot-tracker";

/** Taille d'une plage de sous-identifiants : un espace d'utilisateurs complet. */
export const SUBID_COUNT = 65536;

/** Premier sous-identifiant attribué quand aucune plage n'existe. */
const SUBID_FIRST = 100000;

/** Ce que l'unité systemd et le site nginx décrivent. */
export interface ServiceLayout {
  serviceUser: string;
  serviceGroup: string;
  uid: number;
  /** Dossier personnel du compte : stockage de Podman et configuration de Claude Code. */
  home: string;
  dataDir: string;
  /** Racine du paquet, qui porte `dist/` et le `.env`. */
  packageRoot: string;
  nodePath: string;
  port: number;
}

/** Vrai si `child` est `parent` ou un dossier sous lui. */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Unité systemd du serveur. Le durcissement garde ce dont Podman rootless a
 * besoin : `newuidmap` et `newgidmap` sont setuid (pas de `NoNewPrivileges`),
 * la copie d'une image aux identifiants décalés remet les bits setuid et
 * setgid de ses fichiers (pas de `RestrictSUIDSGID`), et le dossier
 * d'exécution de l'utilisateur reste inscriptible ; bubblewrap, le bac à sable
 * de Claude Code, exclut aussi `RestrictNamespaces`, `PrivateUsers` et
 * `SystemCallFilter`.
 */
export function renderSystemdUnit(layout: ServiceLayout): string {
  const runtimeDir = `/run/user/${layout.uid}`;
  const writable = [layout.home, ...(isInside(layout.dataDir, layout.home) ? [] : [layout.dataDir]), runtimeDir];
  return [
    `# Dependabot Tracker : interface, API et opérations, sur 127.0.0.1:${layout.port}.`,
    `# Écrit par « mcp-dependabot-tracker setup », qui le réécrit à chaque passage.`,
    "",
    "[Unit]",
    "Description=Dependabot Tracker (interface, API, opérations)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${layout.serviceUser}`,
    `Group=${layout.serviceGroup}`,
    `WorkingDirectory=${layout.packageRoot}`,
    "Environment=NODE_ENV=production",
    `Environment=XDG_RUNTIME_DIR=${runtimeDir}`,
    `ExecStart=${layout.nodePath} ${layout.packageRoot}/dist/src/index.js serve`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=30",
    "UMask=0077",
    "",
    "# Podman rootless : newuidmap et newgidmap sont setuid, et la copie des images",
    "# aux identifiants décalés remet les bits setuid et setgid de leurs fichiers.",
    "NoNewPrivileges=false",
    "RestrictSUIDSGID=false",
    "# bubblewrap, le bac à sable de Claude Code : ni RestrictNamespaces, ni PrivateUsers, ni SystemCallFilter.",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=${writable.join(" ")}`,
    "RestrictRealtime=true",
    "LockPersonality=true",
    "",
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=${SERVICE_NAME}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Site nginx en http vers le serveur ; certbot y ajoute ensuite le https. */
export function renderNginxSite(hostname: string, port: number): string {
  return [
    `# Dependabot Tracker : ${hostname} vers 127.0.0.1:${port}.`,
    "# Écrit par « mcp-dependabot-tracker setup » ; certbot y ajoute le certificat.",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${hostname};`,
    "",
    "    client_max_body_size 10m;",
    "",
    "    location / {",
    `        proxy_pass http://127.0.0.1:${port};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_read_timeout 300s;",
    "    }",
    "}",
    "",
  ].join("\n");
}

/** Plage de sous-identifiants : premier identifiant et nombre. */
export interface SubIdRange {
  start: number;
  count: number;
}

/** Plages déclarées pour `user` dans le contenu d'un `/etc/subuid` ou `/etc/subgid`. */
export function subIdRangesOf(text: string, user: string): SubIdRange[] {
  return parseSubIds(text)
    .filter((entry) => entry.owner === user)
    .map(({ start, count }) => ({ start, count }));
}

function parseSubIds(text: string): (SubIdRange & { owner: string })[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [owner, start, count] = line.split(":");
      return { owner, start: Number(start), count: Number(count) };
    })
    .filter((entry) => Number.isInteger(entry.start) && Number.isInteger(entry.count));
}

/** Première plage libre de `SUBID_COUNT` identifiants, au-delà de toutes celles de `/etc/subuid` et `/etc/subgid`. */
export function nextFreeSubIdRange(subuid: string, subgid: string): SubIdRange {
  const end = [...parseSubIds(subuid), ...parseSubIds(subgid)].reduce((max, entry) => Math.max(max, entry.start + entry.count), SUBID_FIRST);
  return { start: end, count: SUBID_COUNT };
}

/** Valeur d'une variable du `.env`, entre guillemets simples (lus tels quels par dotenv) quand elle en a besoin. */
function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]*$/.test(value)) return value;
  if (value.includes("'") || /[\r\n]/.test(value)) throw new Error(`The value ${JSON.stringify(value)} cannot be written to the .env file: it holds a quote or a line break.`);
  return `'${value}'`;
}

/**
 * Contenu du `.env` : les lignes existantes sont gardées, celles des
 * variables de `values` remplacées sur place, les variables absentes ajoutées
 * à la fin.
 */
export function mergeEnvFile(existing: string | undefined, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = (existing ?? "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const merged = lines.map((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${envValue(value)}`;
  });
  for (const [key, value] of pending) merged.push(`${key}=${envValue(value)}`);
  return `${merged.join("\n")}\n`;
}
