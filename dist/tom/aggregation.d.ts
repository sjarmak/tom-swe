import type { UserModel, SessionModel } from './schemas.js';
/**
 * Aggregates a new SessionModel into an existing UserModel.
 *
 * Steps:
 * 1. Apply decay to all existing preferences
 * 2. Extract observations from the session
 * 3. Reinforce existing or add new preferences for each observation
 * 4. Resolve conflicts (same category+key, different values → most recent wins)
 * 5. Return a new UserModel (immutable)
 *
 * @param currentModel - The existing UserModel
 * @param session - The new SessionModel to merge in
 * @param decayDays - Half-life in days for preference decay (default 30)
 * @returns A new UserModel with updated preferences
 */
export declare function aggregateSessionIntoModel(currentModel: UserModel, session: SessionModel, decayDays?: number): UserModel;
//# sourceMappingURL=aggregation.d.ts.map