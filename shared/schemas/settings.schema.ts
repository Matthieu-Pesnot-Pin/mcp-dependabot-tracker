import { z } from "zod";

/** Limites d'une analyse par Claude : tours appliqués par Claude Code, durée appliquée par le tracker. */
export const ANALYSIS_LIMITS = { maxTurns: { min: 1, max: 200 }, maxMinutes: { min: 1, max: 60 } } as const;

export const AnalysisSettingsSchema = z.object({
  auto: z.boolean(),
  maxTurns: z.number().int().min(ANALYSIS_LIMITS.maxTurns.min).max(ANALYSIS_LIMITS.maxTurns.max),
  maxMinutes: z.number().int().min(ANALYSIS_LIMITS.maxMinutes.min).max(ANALYSIS_LIMITS.maxMinutes.max),
});

export type AnalysisSettings = z.infer<typeof AnalysisSettingsSchema>;

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
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  organizer: { url: null, token: null, space: null, owner: null },
  claude: { token: null, savedAt: null },
  analysis: { auto: false, maxTurns: 40, maxMinutes: 15 },
};

/**
 * Réglages tels que la GUI les reçoit : les tokens n'y figurent que par leurs
 * quatre derniers caractères. `ready` est vrai quand l'organizer et Claude sont
 * configurés, condition de l'analyse automatique.
 */
export interface SettingsView {
  organizer: { url: string | null; tokenHint: string | null; space: string | null; owner: string | null };
  claude: { tokenHint: string | null; savedAt: string | null; expiresAt: string | null };
  analysis: AnalysisSettings;
  ready: boolean;
}

/**
 * Corps de `PUT /api/settings`. Un token absent garde la valeur enregistrée ;
 * une adresse vide retire la connexion à l'organizer.
 */
export const SaveSettingsBodySchema = z.object({
  organizerUrl: z.string().trim(),
  organizerToken: z.string().trim().min(1).optional(),
  claudeToken: z.string().trim().min(1).optional(),
  analysis: AnalysisSettingsSchema,
});

export type SaveSettingsBody = z.infer<typeof SaveSettingsBodySchema>;
