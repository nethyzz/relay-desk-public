function serviceError(status: number, resourceLimit = false) {
 if (resourceLimit) return `面板服务暂时超出执行资源（HTTP ${status}），请稍后重试。`;
 if (status === 401) return '登录已过期，请刷新页面重新登录。';
 if (status === 429) return '面板请求过于频繁，请稍后重试。';
 if (status === 502 || status === 503) return `面板服务暂时不可用（HTTP ${status}），请稍后重试。`;
 if (status === 504) return '面板服务响应超时（HTTP 504），请稍后重试。';
 return `面板服务返回了无效响应（HTTP ${status}），请稍后重试。`;
}
export async function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
 const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
 try {
  const response = await fetch('/api/' + path, { method, credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'application/json', ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: value !== undefined ? JSON.stringify(value) : undefined });
  let raw: string;
  try { raw = await response.text(); } catch { throw new Error('面板响应中途断开，请稍后重试。'); }
  let result: any;
  try { result = JSON.parse(raw); } catch {
   // Cloudflare can return an HTML error before Worker code can produce JSON.
   // Never expose the error page or a browser-specific JSON parser exception.
   throw new Error(serviceError(response.status, /Worker exceeded resource limits/.test(raw.slice(0,8192))));
  }
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : serviceError(response.status));
  return result;
 } catch (error) {
  if (controller.signal.aborted) throw new Error('面板请求超时，请稍后重试。');
  if (error instanceof TypeError || error instanceof DOMException) throw new Error('无法连接面板服务，请检查网络后重试。');
  throw error;
 } finally { clearTimeout(timer); }
}
