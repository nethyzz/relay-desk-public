export async function saveAndRefresh<T>(write: () => Promise<T>, refresh: () => Promise<void>) {
 const result = await write();
 try { await refresh(); return { result, refreshError: null }; }
 catch (error) { return { result, refreshError: error instanceof Error ? error.message : '面板暂时无法刷新' }; }
}
