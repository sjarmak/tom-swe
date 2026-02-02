import { type SessionLog, type SessionModel, type UserModel } from './schemas';
declare function globalTomDir(): string;
declare function projectTomDir(): string;
declare function globalSessionPath(sessionId: string): string;
declare function projectSessionPath(sessionId: string): string;
declare function globalSessionModelPath(sessionId: string): string;
declare function projectSessionModelPath(sessionId: string): string;
declare function globalUserModelPath(): string;
declare function projectUserModelPath(): string;
export declare function readSessionLog(sessionId: string, scope?: 'global' | 'project'): SessionLog | null;
export declare function writeSessionLog(sessionLog: SessionLog, scope?: 'global' | 'project'): void;
export declare function readSessionModel(sessionId: string, scope?: 'global' | 'project'): SessionModel | null;
export declare function writeSessionModel(sessionModel: SessionModel, scope?: 'global' | 'project'): void;
export declare function readUserModel(scope?: 'global' | 'project' | 'merged'): UserModel | null;
export declare function writeUserModel(userModel: UserModel, scope?: 'global' | 'project'): void;
export { globalTomDir, projectTomDir, globalSessionPath, projectSessionPath, globalSessionModelPath, projectSessionModelPath, globalUserModelPath, projectUserModelPath, };
//# sourceMappingURL=memory-io.d.ts.map