import { z } from "zod";

/** Limites d'une session de corrections par Claude : tours appliqués par Claude Code, durée appliquée par le tracker. */
export const ANALYSIS_LIMITS = { maxTurns: { min: 1, max: 200 }, maxMinutes: { min: 1, max: 60 } } as const;

export const AnalysisSettingsSchema = z.object({
  maxTurns: z.number().int().min(ANALYSIS_LIMITS.maxTurns.min).max(ANALYSIS_LIMITS.maxTurns.max),
  maxMinutes: z.number().int().min(ANALYSIS_LIMITS.maxMinutes.min).max(ANALYSIS_LIMITS.maxMinutes.max),
});

export type AnalysisSettings = z.infer<typeof AnalysisSettingsSchema>;

/**
 * Token GitHub en lecture seule que le tracker transmet aux scripts de
 * déploiement, pour que leur `git pull` s'authentifie ; `savedAt` est sa date
 * d'enregistrement.
 */
export const DeploySettingsSchema = z.object({
  token: z.string().nullable(),
  savedAt: z.string().nullable(),
});

/**
 * Réglages enregistrés dans `<données>/settings.json`. `organizer.space` et
 * `organizer.owner` sont l'espace du token et son propriétaire, relevés au
 * dernier test de la connexion ; `claude.savedAt` est la date d'enregistrement
 * du token Claude, valable un an.
 */
export const SettingsSchema = z.object({
  organizer: z.object({
    url: z.string().nullable(),
    token: z.string().nullable(),
    space: z.string().nullable(),
    owner: z.string().nullable(),
  }),
  claude: z.object({
    token: z.string().nullable(),
    savedAt: z.string().nullable(),
  }),
  analysis: AnalysisSettingsSchema,
  deploy: DeploySettingsSchema.default({ token: null, savedAt: null }),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  organizer: { url: null, token: null, space: null, owner: null },
  claude: { token: null, savedAt: null },
  analysis: { maxTurns: 40, maxMinutes: 15 },
  deploy: { token: null, savedAt: null },
};

/**
 * Réglages tels que la GUI les reçoit : les tokens n'y figurent que par leurs
 * quatre derniers caractères. `ready` est vrai quand l'organizer et Claude sont
 * configurés, condition des corrections par Claude.
 */
export interface SettingsView {
  organizer: { url: string | null; tokenHint: string | null; space: string | null; owner: string | null };
  claude: { tokenHint: string | null; savedAt: string | null; expiresAt: string | null };
  analysis: AnalysisSettings;
  ready: boolean;
  deploy: { tokenHint: string | null; savedAt: string | null };
}

/**
 * Corps de `PUT /api/settings`. Un token absent garde la valeur enregistrée ;
 * une adresse vide retire la connexion à l'organizer, `deployToken: null` retire
 * le token de déploiement.
 */
export const SaveSettingsBodySchema = z.object({
  organizerUrl: z.string().trim(),
  organizerToken: z.string().trim().min(1).optional(),
  claudeToken: z.string().trim().min(1).optional(),
  deployToken: z.string().trim().min(1).nullable().optional(),
  analysis: AnalysisSettingsSchema,
});

export type SaveSettingsBody = z.infer<typeof SaveSettingsBodySchema>;
