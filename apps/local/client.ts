import { invoke, isTauri } from '@tauri-apps/api/core';

export interface LocalState { generation: number; database: string; secrets: { SESSION_SECRET: string; MASTER_KEY: string; LOCAL_RUNNER_TOKEN: string }; directory: string }
type Reply = { id: number; result?: unknown; error?: string };
let worker: Worker | null = null;
let sequence = 0;
let ready: Promise<unknown> | null = null;
let closing = false;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const requests = new Map<string, AbortController>();
const PREVIEW_KEY = 'relay-local-app-preview-v1';
let previewState: LocalState | null = null;

function request(action: string, value?: unknown): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ id, action, value }); });
}
async function host(action: string, value: any) {
  if (isTauri()) {
    if (action === 'load') return invoke<LocalState>('load_local_state');
    if (action === 'save') return invoke('save_local_database', value);
    if (action === 'restore') return invoke('restore_local_state', value);
    if (action === 'http') return JSON.stringify(await invoke('native_http', { input: value }));
    if (action === 'cancel') return invoke('cancel_http', { id: value });
    if (action === 'smtp') return invoke('native_smtp', { input: value });
  } else {
    // Browser preview uses an isolated database; the shipped apps use private native files.
    if (action === 'load') {
      if (previewState) return previewState;
      const saved = localStorage.getItem(PREVIEW_KEY);
      previewState = saved ? JSON.parse(saved) : { generation: 1, database: '', directory: '浏览器本地预览', secrets: { SESSION_SECRET: randomKey(48), MASTER_KEY: randomKey(32), LOCAL_RUNNER_TOKEN: randomKey(32) } };
      return previewState;
    }
    if (action === 'save') {
      const state = await host('load', undefined) as LocalState;
      if (state.generation !== value.generation) throw new Error('旧运行环境已关闭');
      previewState = { ...state, database: value.database };
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(previewState));
      return;
    }
    if (action === 'restore') {
      const state = await host('load', undefined) as LocalState;
      previewState = { ...state, generation: state.generation + 1, database: value.database, secrets: { MASTER_KEY: value.masterKey, SESSION_SECRET: randomKey(48), LOCAL_RUNNER_TOKEN: randomKey(32) } };
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(previewState)); return;
    }
    if (action === 'cancel') { requests.get(value)?.abort(); return; }
    if (action === 'smtp') throw new Error('浏览器预览不发送邮件，请使用本地应用。');
    if (action === 'http') {
      const controller = new AbortController(); requests.set(value.id, controller);
      try {
        const response = await fetch(value.url, { method: value.method, headers: value.headers, body: value.method === 'GET' ? undefined : value.body, signal: controller.signal, redirect: 'error' });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 1048576) throw new Error('响应过大');
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        return JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers), body_base64: btoa(binary) });
      } finally { requests.delete(value.id); }
    }
  }
  throw new Error('不支持的本机操作');
}
function randomKey(length: number) { let binary = ''; for (const byte of crypto.getRandomValues(new Uint8Array(length))) binary += String.fromCharCode(byte); return btoa(binary); }

export function initializeLocal() {
  if (closing) return Promise.reject(new Error('本机应用正在关闭或恢复数据。'));
  if (!ready) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const owner = worker;
    worker.onmessage = async event => {
      const message = event.data;
      if (message.host) {
        try { const result = await host(message.action, message.value); owner.postMessage({ hostReply: message.id, result }); }
        catch { owner.postMessage({ hostReply: message.id, error: '本机操作失败，请检查网络、磁盘或权限。' }); }
        return;
      }
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error)); else callback.resolve(message.result);
    };
    worker.onerror = () => { for (const item of pending.values()) item.reject(new Error('本地运行环境加载失败，请重新打开应用。')); pending.clear(); };
    ready = request('initialize', { root: new URL('/', location.href).href, preview: !isTauri() });
  }
  return ready;
}
export async function localAPI<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  await initializeLocal();
  const result = await request('api', { path, method, value });
  if (result.status >= 400) throw new Error(result.body?.error || '本地操作失败');
  return result.body as T;
}
export async function localControl<T = any>(action: string, value?: unknown): Promise<T> { await initializeLocal(); return request(action, value); }
export async function shutdownLocal() {
  if (!worker) return;
  closing = true;
  let initialized = true;
  try { await ready; } catch { initialized = false; }
  try { if (initialized) await request('shutdown'); }
  catch (error) { closing = false; throw error; }
  worker.terminate(); worker = null; ready = null;
  for (const item of pending.values()) item.reject(new Error('本地运行环境已关闭。')); pending.clear();
}
export async function resetLocal() {
  await shutdownLocal();
  if (isTauri()) await invoke('reset_local_data'); else localStorage.removeItem(PREVIEW_KEY);
  previewState = null;
  for (const key of ['relay-target-sort', 'relay-run-presets-open']) localStorage.removeItem(key);
  location.reload();
}
export async function exportLocalFile(name: string, contents: string) {
  if (isTauri()) return invoke<boolean>('export_local_file', { name, contents });
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
export async function restoreLocal(data: { database: string; master_key: string }) {
  const database = await localControl<string>('prepare-backup', data.database);
  await shutdownLocal();
  await host('restore', { database, masterKey: data.master_key });
  location.reload();
}
export async function clearLocalCache() {
  if (isTauri()) await invoke('clear_local_cache');
  for (const key of ['relay-target-sort', 'relay-run-presets-open']) localStorage.removeItem(key);
}
export async function showLocalDirectory() { if (isTauri()) await invoke('show_data_directory'); }
export function bindLocalLifecycle() {
  if (/iPhone|iPad|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) document.addEventListener('visibilitychange', () => { if (ready) void localControl(document.visibilityState === 'hidden' ? 'suspend' : 'resume').catch(() => {}); });
  if (!isTauri()) return;
  void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
    const window = getCurrentWindow();
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      globalThis.dispatchEvent(new CustomEvent('relay-local-error', { detail: '正在停止检测并保存报告，完成后会关闭应用。' }));
      try { await shutdownLocal(); await invoke('quit_local_app'); }
      catch { closing = false; globalThis.dispatchEvent(new CustomEvent('relay-local-error', { detail: '任务尚未安全停止，请稍后再关闭应用。' })); }
    };
    await window.onCloseRequested(event => { event.preventDefault(); void close(); });
    const { listen } = await import('@tauri-apps/api/event'); await listen('relay-app-close', () => { void close(); });
  }).catch(() => {});
}
