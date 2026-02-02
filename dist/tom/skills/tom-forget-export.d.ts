/**
 * /tom forget [session-id] — removes a specific session and rebuilds Tier 3.
 * /tom export — exports all ToM data to a single JSON file.
 */
import type { SessionLog, SessionModel, UserModel } from '../schemas.js';
import type { TomConfig } from '../config.js';
export interface ForgetResult {
    readonly sessionId: string;
    readonly tier1Deleted: boolean;
    readonly tier2Deleted: boolean;
    readonly tier3Rebuilt: boolean;
}
export interface ExportData {
    readonly exportedAt: string;
    readonly version: '1.0';
    readonly config: TomConfig;
    readonly tier1Sessions: readonly SessionLog[];
    readonly tier2Models: readonly SessionModel[];
    readonly tier3UserModel: UserModel | null;
    readonly usageLog: readonly string[];
}
/**
 * Forgets a specific session: deletes Tier 1 and Tier 2 files,
 * rebuilds Tier 3 user model without the deleted session's data.
 */
export declare function forgetSession(sessionId: string): ForgetResult;
export declare function formatForgetResult(result: ForgetResult): string;
/**
 * Collects all ToM data (Tier 1, 2, 3, config, usage log) for export.
 */
export declare function collectExportData(): ExportData;
/**
 * Exports all ToM data to a JSON file in the current directory.
 * Returns the path of the exported file.
 */
export declare function exportToFile(): string;
export declare function formatExportResult(filePath: string, data: ExportData): string;
export declare function main(): void;
//# sourceMappingURL=tom-forget-export.d.ts.map