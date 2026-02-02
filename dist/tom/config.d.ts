/**
 * ToM configuration schema and opt-in system.
 *
 * Provides a Zod-validated configuration schema for the ToM system,
 * read from ~/.claude/tom/config.json.
 * All hooks use isTomEnabled() as a guard before executing.
 */
import { z } from 'zod';
export declare const TomConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    consultThreshold: z.ZodDefault<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    models: z.ZodDefault<z.ZodObject<{
        memoryUpdate: z.ZodDefault<z.ZodString>;
        consultation: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
    preferenceDecayDays: z.ZodDefault<z.ZodNumber>;
    maxSessionsRetained: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type TomConfig = z.infer<typeof TomConfigSchema>;
/**
 * Reads the "tom" key from ~/.claude/settings.json,
 * validates it against the Zod schema, and returns
 * a fully-defaulted TomConfig.
 *
 * Returns all defaults if the file is missing, unreadable,
 * or the tom key is absent/invalid.
 */
export declare function readTomConfig(): TomConfig;
/**
 * Returns true if ToM is enabled in settings.
 * Used as a guard in all hooks to skip execution when disabled.
 */
export declare function isTomEnabled(): boolean;
//# sourceMappingURL=config.d.ts.map