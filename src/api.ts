export async function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
 const response = await fetch('/api/' + path, { method, credentials: 'same-origin', headers: value !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: value !== undefined ? JSON.stringify(value) : undefined });
 const result = await response.json();
 if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
 return result;
}
