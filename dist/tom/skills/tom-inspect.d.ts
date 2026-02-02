/**
 * /tom inspect skill — displays exactly what data the ToM system
 * has stored about the user, including all sessions and the full
 * Tier 3 user model in human-readable format.
 */
import type { UserModel } from '../schemas.js';
export interface SessionEntry {
    readonly sessionId: string;
    readonly date: string;
    readonly intent: string;
    readonly scope: 'global' | 'project';
    readonly willBePruned: boolean;
}
export interface InspectOutput {
    readonly sessions: readonly SessionEntry[];
    readonly userModel: UserModel | null;
    readonly maxSessionsRetained: number;
    readonly totalSessionCount: number;
    readonly pruneCount: number;
}
export declare function getInspectData(): InspectOutput;
export declare function formatInspect(data: InspectOutput): string;
export declare function main(): void;
//# sourceMappingURL=tom-inspect.d.ts.map