/**
 * /tom status skill — displays the current state of the ToM model,
 * session count, preference summary, and configuration.
 */
import type { PreferenceCluster } from '../schemas.js';
export interface StorageStats {
    readonly tier1SessionCount: number;
    readonly tier2ModelCount: number;
    readonly tier3SizeBytes: number;
}
export interface StatusOutput {
    readonly hasModel: boolean;
    readonly config: {
        readonly enabled: boolean;
        readonly consultThreshold: string;
        readonly models: {
            readonly memoryUpdate: string;
            readonly consultation: string;
        };
        readonly preferenceDecayDays: number;
        readonly maxSessionsRetained: number;
    };
    readonly storage: StorageStats;
    readonly topPreferences: readonly PreferenceCluster[];
    readonly interactionStyleSummary: string;
    readonly codingStyleSummary: string;
}
export declare function getStatus(): StatusOutput;
export declare function formatStatus(status: StatusOutput): string;
export declare function main(): void;
//# sourceMappingURL=tom-status.d.ts.map