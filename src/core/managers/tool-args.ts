import { requireString, rejectUnknownFields, type Args } from "../../tools/types.js";

/** Nom de paquet, contrainte de version ou nom de script : pas d'option, pas d'espace. */
const NAME = /^[A-Za-z0-9@/._^~<>=*:+|-]+$/;

/** Lit un nom de paquet ou de script ; lève une erreur s'il contient autre chose. */
export function checkedName(value: string, field: string): string {
  if (!NAME.test(value) || value.startsWith("-")) throw new Error(`"${field}" must be a package or script name (got ${JSON.stringify(value)}).`);
  return value;
}

/** Lit l'argument `field`, nom de paquet ou de script obligatoire. */
export function nameArg(args: Args, field: string): string {
  return checkedName(requireString(args, field), field);
}

/** Lit l'argument facultatif `packages`, liste de noms de paquets. */
export function packagesArg(args: Args): string[] {
  const packages = args?.packages ?? [];
  if (!Array.isArray(packages) || packages.some((item) => typeof item !== "string")) throw new Error('"packages" must be a list of package names.');
  return packages.map((item: string) => checkedName(item.trim(), "packages"));
}

/** Refuse tout champ hors de `project` et de `fields`. */
export function onlyFields(args: Args, fields: string[] = []): void {
  rejectUnknownFields(args, ["project", ...fields]);
}

/** Propriété `packages` des outils qui ajoutent ou montent des paquets. */
export const PACKAGES_PROPERTY = { type: "array", items: { type: "string" }, description: "Packages to add or upgrade (optional)." };
