export interface Statement {
 bind(...values: unknown[]): Statement;
 first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
 all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
 run(): Promise<{ meta: { changes: number }; success: boolean }>;
}
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ meta: { changes: number }; success: boolean }[]> }
export interface Env {
 DB: Database; ASSETS?: { fetch(request: Request): Promise<Response> };
 APP_ORIGIN: string; SESSION_SECRET: string; MASTER_KEY: string;
 LOGIN_CREDENTIALS?: string; GITHUB_OWNER_ID?: string;
 GITHUB_REPOSITORY?: string; GITHUB_REPOSITORY_ID?: string; GITHUB_WORKFLOW?: string;
 GITHUB_REF?: string; GITHUB_DISPATCH_TOKEN?: string;
 DEV_MODE?: string; LOCAL_RUNNER_TOKEN?: string; LOCAL_RUNNER_READY?: string; LOCAL_PREVIEW_ONLY?: string;
}
export interface Context { waitUntil(promise: Promise<unknown>): void }
export class ApiError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
