import { DatabaseSync } from 'node:sqlite';
import type { Database, Statement } from '../worker/types.ts';
export class SQLiteDatabase implements Database {
 connection: DatabaseSync;
 private pending: Promise<unknown> = Promise.resolve();
 constructor(path = ':memory:') { this.connection = new DatabaseSync(path); this.connection.exec('PRAGMA foreign_keys=ON;'); }
 exec(sql: string) { this.connection.exec(sql); }
 prepare(sql: string): Statement {
  let bindings: any[] = []; const db = this.connection;
  const statement: Statement = {
   bind(...values: any[]) { bindings = values.map(v => v === undefined ? null : v); return statement; },
   async first<T>(column?: string) { const found = db.prepare(sql).get(...bindings); return found ? (column ? found[column] : found) as T : null; },
   async all<T>() { return { results: db.prepare(sql).all(...bindings) as T[] }; },
   async run() { const result = db.prepare(sql).run(...bindings); return { meta: { changes: Number(result.changes) }, success: true }; },
  }; return statement;
 }
 async batch(statements: Statement[]) {
  const operation = this.pending.then(async () => { this.connection.exec('BEGIN IMMEDIATE'); try { const result = []; for (const s of statements) result.push(await s.run()); this.connection.exec('COMMIT'); return result; } catch (e) { this.connection.exec('ROLLBACK'); throw e; } });
  this.pending = operation.catch(() => {}); return operation;
 }
 close() { this.connection.close(); }
}
