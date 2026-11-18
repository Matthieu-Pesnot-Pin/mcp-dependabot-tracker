/**
 * Choix de la version de PHP d'un projet Composer, parmi celles des images
 * officielles, d'après `config.platform.php` (la version que Composer suppose
 * pour résoudre les dépendances) ou, à défaut, la contrainte `require.php`.
 */

/** Versions de PHP des images officielles `php:<version>-cli`, de la plus ancienne à la plus récente. */
export const PHP_VERSIONS = ["8.2", "8.3", "8.4", "8.5"] as const;

type Version = [number, number, number];

/** Correctifs essayés pour décider si une version mineure satisfait une contrainte. */
const MAX_PATCH = 99;

function parseVersion(text: string): { version: Version; parts: number } | null {
  const match = /^v?(\d+)(?:\.(\d+|\*|x))?(?:\.(\d+|\*|x))?/i.exec(text.trim());
  if (!match) return null;
  const numbers = [match[1], match[2], match[3]].filter((part) => part !== undefined && /^\d+$/.test(part)).map(Number);
  return { version: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0], parts: numbers.length };
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** Plus petite version au-delà de toutes celles qui commencent par les `parts` premiers nombres de `version`. */
function nextAfter(version: Version, parts: number): Version {
  if (parts <= 1) return [version[0] + 1, 0, 0];
  if (parts === 2) return [version[0], version[1] + 1, 0];
  return [version[0], version[1], version[2] + 1];
}

/** Vrai si `version` satisfait une contrainte simple (`^8.1`, `>=8.2`, `8.3.*`, `~8.2.1`, `8.4`…). */
function satisfiesTerm(version: Version, term: string): boolean {
  const text = term.replace(/@\w+$/, "").trim();
  if (text === "" || text === "*") return true;
  const operator = /^(\^|~|>=|<=|>|<|!=|==|=)?\s*(.*)$/.exec(text)!;
  const parsed = parseVersion(operator[2]);
  if (!parsed) return false;
  const { version: bound, parts } = parsed;
  const wildcard = /\.(\*|x)/i.test(operator[2]);
  switch (operator[1]) {
    case "^": {
      const upper: Version = bound[0] > 0 ? [bound[0] + 1, 0, 0] : bound[1] > 0 || parts < 3 ? [0, bound[1] + 1, 0] : [0, 0, bound[2] + 1];
      return compare(version, bound) >= 0 && compare(version, upper) < 0;
    }
    case "~":
      return compare(version, bound) >= 0 && compare(version, nextAfter(bound, Math.max(parts - 1, 1))) < 0;
    case ">=":
      return compare(version, bound) >= 0;
    case ">":
      return compare(version, bound) > 0;
    case "<=":
      return compare(version, bound) <= 0;
    case "<":
      return compare(version, bound) < 0;
    case "!=":
      return compare(version, bound) !== 0;
    default:
      if (wildcard || parts < 3) return compare(version, bound) >= 0 && compare(version, nextAfter(bound, parts)) < 0;
      return compare(version, bound) === 0;
  }
}

/** Vrai si `version` satisfait une contrainte Composer (`||` ou `|` entre alternatives, espace ou virgule entre conditions, intervalles `a - b`). */
export function satisfies(version: Version, constraint: string): boolean {
  return constraint.split(/\s*\|\|?\s*/).some((alternative) => {
    const range = /^(\S+)\s+-\s+(\S+)$/.exec(alternative.trim());
    if (range) {
      const upper = parseVersion(range[2]);
      if (!upper) return false;
      return satisfiesTerm(version, `>=${range[1]}`) && (upper.parts < 3 ? compare(version, nextAfter(upper.version, upper.parts)) < 0 : compare(version, upper.version) <= 0);
    }
    const terms = alternative
      .replace(/(>=|<=|>|<|!=|==|=|\^|~)\s+/g, "$1")
      .split(/[\s,]+/)
      .filter(Boolean);
    return terms.every((term) => satisfiesTerm(version, term));
  });
}

/** Vrai si une version de la série `minor` (`8.3`) satisfait la contrainte. */
function minorSatisfies(minor: string, constraint: string): boolean {
  const [major, minorNumber] = minor.split(".").map(Number);
  for (let patch = 0; patch <= MAX_PATCH; patch++) if (satisfies([major, minorNumber, patch], constraint)) return true;
  return false;
}

/**
 * Version de PHP de l'image d'un projet, d'après son `composer.json` : la
 * série de `config.platform.php`, sinon la plus ancienne série qui satisfait
 * `require.php`, sinon la plus récente. Lève une erreur quand aucune image
 * officielle ne convient.
 */
export function phpVersionFor(manifest: any): string {
  const platform = manifest?.config?.platform?.php;
  if (typeof platform === "string") {
    const parsed = parseVersion(platform);
    const minor = parsed ? `${parsed.version[0]}.${parsed.version[1]}` : platform;
    if (!(PHP_VERSIONS as readonly string[]).includes(minor)) {
      throw new Error(`composer.json sets config.platform.php to ${platform}: the official PHP images cover ${PHP_VERSIONS.join(", ")}.`);
    }
    return minor;
  }
  const required = manifest?.require?.php;
  if (typeof required !== "string") return PHP_VERSIONS[PHP_VERSIONS.length - 1];
  const minor = PHP_VERSIONS.find((candidate) => minorSatisfies(candidate, required));
  if (!minor) throw new Error(`composer.json requires PHP ${required}: the official PHP images cover ${PHP_VERSIONS.join(", ")}.`);
  return minor;
}
