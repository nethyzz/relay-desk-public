/// <reference lib="webworker" />
import { handleRequest, tick } from '../../worker/index.ts';
import { ensurePublicHostname } from '../../worker/security.ts';
import { rows, finishRun, finishBatch, finalizeRunSets, reconcileRequests, stopRuns } from '../../worker/data.ts';
import type { Database, Env, Statement } from '../../worker/types.ts';
import type { LocalState } from './client.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const browserFetch = globalThis.fetch.bind(globalThis);
const callbacks = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let sequence = 0;
let py: any;
let state: LocalState;
let env: Env;
let stopped = false;
let suspended = false;
let running = false;
let activePump: Promise<void> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let batchId = '';
let lease = '';
let timer: ReturnType<typeof setInterval> | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();
const tasks = new Set<Promise<unknown>>();
const context = { waitUntil(promise: Promise<unknown>) { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); } };

function host(action: string, value?: unknown): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => { callbacks.set(id, { resolve, reject }); scope.postMessage({ host: true, id, action, value }); });
}
function python(name: string, ...values: unknown[]) { const module = py.globals.get('relay_runtime'); const fn = module[name]; try { return fn(...values); } finally { fn.destroy(); module.destroy(); } }
function save() {
  const database = python('panel_snapshot');
  const next = writeQueue.then(() => host('save', { database, generation: state.generation }));
  writeQueue = next.catch(() => {});
  return next;
}
class LocalStatement implements Statement {
  params: unknown[] = [];
  readonly sql: string;
  constructor(sql: string) { this.sql = sql; }
  bind(...params: unknown[]) { this.params = params.map(value => value === undefined ? null : value); return this; }
  async all<T>() { return { results: JSON.parse(python('panel_query', this.sql, JSON.stringify(this.params), 'all')) as T[] }; }
  async first<T>(column?: string): Promise<T | null> { const result = (await this.all<any>()).results[0]; return result ? (column ? result[column] : result) : null; }
  async run() { const result = JSON.parse(python('panel_query', this.sql, JSON.stringify(this.params), 'run')); await save(); return result; }
}
class LocalDatabase implements Database {
  prepare(sql: string) { return new LocalStatement(sql); }
  async batch(statements: LocalStatement[]) { const result = JSON.parse(python('panel_batch', JSON.stringify(statements.map(item => ({ sql: item.sql, params: item.params })) ))); await save(); return result; }
}
async function route(path: string, method = 'GET', value?: unknown, runner = false) {
  const headers: Record<string, string> = { Origin: env.APP_ORIGIN, Accept: 'application/json' };
  if (value !== undefined) headers['Content-Type'] = 'application/json';
  if (runner) { headers['X-Local-Runner'] = env.LOCAL_RUNNER_TOKEN!; headers['X-Local-Run'] = 'native-app'; if (lease) headers.Authorization = 'Bearer ' + lease; }
  const request = new Request(env.APP_ORIGIN + '/api/' + path, { method, headers, body: value === undefined ? undefined : JSON.stringify(value) });
  // WebKit filters Origin from Request's guarded headers. This request stays
  // inside this worker; it is never sent over HTTP. Keep the app-generated
  // headers available to the unchanged backend's origin and runner checks.
  Object.defineProperty(request, 'headers', { value: new Headers(headers) });
  const response = await handleRequest(request, env, context);
  return { status: response.status, body: await response.json() as any };
}
async function runner(path: string, value: unknown) {
  const result = await route('runner/batches/' + batchId + '/' + path, 'POST', value, true);
  if (result.status >= 400) throw new Error('本地任务写入失败');
  return result.body;
}
function pump() {
  if (!stopped && !suspended && !activePump) { activePump = executeBatch().finally(() => { activePump = null; if (!stopped && !suspended) setTimeout(pump, 1000); }); }
  return activePump;
}
async function deliverNotices() {
  const payload = await runner('notices', {});
  if (!payload.mail) return;
  for (const notice of payload.notices) {
    if (stopped || suspended) break;
    const control = await runner('notice-begin', { notice_id: notice.id });
    if (!control.send) continue;
    let result;
    try {
      const message = python('local_notice_message', JSON.stringify(payload.mail), JSON.stringify(notice));
      result = await host('smtp', { ...payload.mail, message });
    } catch { result = { ok: false, error_code: 'smtp_connect' }; }
    await runner('notice-result', { notice_id: notice.id, ...result });
  }
}
async function executeBatch() {
  if (stopped || suspended || running) return;
  running = true;
  const started = Date.now();
  try {
    const queue = await route('runner/queue', 'GET', undefined, true);
    if (!queue.body.batches?.length) return;
    batchId = queue.body.batches[0].id;
    const claim = await runner('claim', {});
    if (claim.done) return;
    lease = claim.lease;
    const checkControl = async () => { const control = await runner('heartbeat', {}); python('relay_stop', JSON.stringify(control.stop_run_ids || [])); };
    heartbeat = setInterval(() => { void checkControl().catch(() => {}); }, 3000);
    if (claim.kind === 'detection') {
      for (const job of claim.jobs) await ensurePublicHostname(job.config.base_url);
      const cancelled = new Set((await rows(env, "SELECT id FROM runs WHERE batch_id=? AND stop_requested_at IS NOT NULL", batchId)).map(run => run.id));
      for (const job of claim.jobs.filter((job: any) => cancelled.has(job.id))) await runner('results/' + job.id, { status: 'cancelled', attempts: 0, report: null });
      const jobs = claim.jobs.filter((job: any) => !cancelled.has(job.id));
      try { py.globals.set('relay_jobs_json', JSON.stringify(jobs)); await py.runPythonAsync('await relay_runtime.relay_detect_batch(relay_jobs_json)'); }
      finally { py.globals.delete('relay_jobs_json'); }
    }
    await deliverNotices();
    await runner('complete', { minutes: Math.max(1, Math.ceil((Date.now() - started) / 60000)) });
  } catch {
    if (batchId) {
      const active = await rows(env, "SELECT id,reserved_attempts FROM runs WHERE batch_id=? AND status='running'", batchId);
      for (const run of active) await runner('results/' + run.id, { status: 'failed', attempts: run.reserved_attempts, report: null }).catch(() => {});
      await runner('complete', { minutes: Math.max(1, Math.ceil((Date.now() - started) / 60000)) }).catch(() => {});
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat); heartbeat = null;
    batchId = ''; lease = ''; running = false;
  }
}
async function recoverInterrupted() {
  const interrupted = await rows(env, "SELECT id,batch_id,reserved_attempts FROM runs WHERE status='running'");
  if (interrupted.length) await stopRuns(env, interrupted.map(run => run.id));
  for (const run of interrupted) {
    // A crash can occur after dispatch and before a progress update. Keep the
    // request reservation conservative instead of silently granting it back.
    await finishRun(env, run.batch_id, run.id, { status: 'cancelled', attempts: run.reserved_attempts, report: null });
    await env.DB.prepare('UPDATE runs SET error=? WHERE id=?').bind('应用上次异常退出，已保留部分报告；未确认的请求按预留上限计入用量。', run.id).run();
  }
  for (const batch of await rows(env, "SELECT id,reserved_minutes FROM batches WHERE status='running'")) { await reconcileRequests(env, batch.id); await finishBatch(env, batch.id, batch.reserved_minutes); }
  await env.DB.prepare("UPDATE notices SET status='failed',error=? WHERE status='processing'").bind('应用上次异常退出，邮件发送结果未确认。请检查收件箱后再试。').run();
  await finalizeRunSets(env);
}
async function stopCurrent() {
  const active = await rows(env, "SELECT id FROM runs WHERE status IN ('queued','running')");
  if (active.length) { await stopRuns(env, active.map(run => run.id)); python('relay_stop', JSON.stringify(active.map(run => run.id))); }
}
async function initialize(value: { root: string; preview: boolean }) {
  state = await host('load');
  const runtimeRoot = new URL('runtime/', value.root).href;
  const { loadPyodide } = await import(/* @vite-ignore */ runtimeRoot + 'pyodide.mjs');
  py = await loadPyodide({ indexURL: runtimeRoot, stdout: () => {}, stderr: () => {} });
  await py.loadPackage(['numpy', 'httpx', 'sqlite3', 'ssl']);
  const bundle = await (await browserFetch(runtimeRoot + 'engine.json')).json();
  for (const [name, source] of Object.entries(bundle.files)) {
    const path = '/engine/' + name;
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/'))); py.FS.writeFile(path, source);
  }
  py.runPython('import sys; sys.path.insert(0, "/engine"); import relay_runtime');
  python('panel_restore', state.database);
  python('panel_migrate', JSON.stringify(bundle.migrations));
  env = { ...state.secrets, DB: new LocalDatabase(), APP_ORIGIN: 'http://127.0.0.1:8787', DEV_MODE: 'local', LOCAL_RUNNER_READY: '1' };
  // All application traffic uses native TLS. Runtime assets were loaded locally above.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const id = crypto.randomUUID(); const abort = () => { void host('cancel', id); };
    if (request.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = JSON.parse(await host('http', { id, url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: request.method === 'GET' ? '' : await request.text() }));
      return new Response(Uint8Array.from(atob(result.body_base64), char => char.charCodeAt(0)), { status: result.status, headers: result.headers });
    } finally { request.signal.removeEventListener('abort', abort); }
  };
  (globalThis as any).relay_http = (raw: string) => host('http', JSON.parse(raw));
  (globalThis as any).relay_cancel = (id: string) => { void host('cancel', id); };
  (globalThis as any).relay_progress = async (id: string, report: string) => { await runner('progress', { run_id: id, report: JSON.parse(report) }); };
  (globalThis as any).relay_result = async (id: string, result: string) => { await runner('results/' + id, JSON.parse(result)); };
  // A previous app termination must not leave reports indefinitely marked as running.
  await recoverInterrupted();
  await save();
  timer = setInterval(() => { if (!stopped && !suspended) void tick(env).then(pump).catch(() => {}); }, 60000);
  void pump();
  return { directory: state.directory, preview: value.preview };
}

scope.onmessage = async event => {
  const message = event.data;
  if (message.hostReply) { const callback = callbacks.get(message.hostReply); if (callback) { callbacks.delete(message.hostReply); message.error ? callback.reject(new Error(message.error)) : callback.resolve(message.result); } return; }
  try {
    let result;
    if (message.action === 'initialize') result = await initialize(message.value);
    else if (message.action === 'api') { if (stopped) throw new Error('应用正在关闭'); result = await route(message.value.path, message.value.method, message.value.value); if (message.value.path === 'runs/stop') { const ids = await rows(env, "SELECT id FROM runs WHERE status='running' AND stop_requested_at IS NOT NULL"); python('relay_stop', JSON.stringify(ids.map(row => row.id))); } void pump(); }
    else if (message.action === 'info') result = { directory: state.directory, running };
    else if (message.action === 'backup') { await save(); result = { database: python('panel_snapshot'), master_key: state.secrets.MASTER_KEY }; }
    else if (message.action === 'verify-backup') result = python('panel_verify', message.value);
    else if (message.action === 'prepare-backup') result = python('panel_prepare_restore', message.value);
    else if (message.action === 'suspend') { suspended = true; await stopCurrent(); await save(); result = true; }
    else if (message.action === 'resume') { suspended = false; if (!stopped) void tick(env).then(pump).catch(() => {}); result = true; }
    else if (message.action === 'shutdown') { stopped = true; if (timer) clearInterval(timer); await stopCurrent(); await activePump; await Promise.allSettled([...tasks]); await stopCurrent(); await save(); result = true; }
    else throw new Error('未知的本地操作');
    scope.postMessage({ id: message.id, result });
  } catch { scope.postMessage({ id: message.id, error: '本地操作未完成，请重新打开应用，或检查设备存储与网络。' }); }
};
