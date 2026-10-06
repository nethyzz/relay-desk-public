export interface BackupData { database: string; master_key: string }
interface EncryptedBackup { format: 'relay-desk-local'; version: 1; created_at: string; salt: string; iv: string; ciphertext: string }
const MAX_BACKUP = 256 * 1024 * 1024;
const encoder = new TextEncoder();
function encode(bytes: Uint8Array) { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(text); }
function decode(text: string) { return Uint8Array.from(atob(text), char => char.charCodeAt(0)); }
async function key(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 210000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptBackup(data: BackupData, password: string) {
  if (password.length < 10 || password.length > 1024) throw new Error('备份密码需要 10–1024 个字符。');
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(JSON.stringify(data));
  if (bytes.length > MAX_BACKUP / 1.4) throw new Error('备份过大，请先导出旧报告。');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('relay-desk-local:1') }, await key(password, salt), bytes);
  const backup: EncryptedBackup = { format: 'relay-desk-local', version: 1, created_at: new Date().toISOString(), salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
  return JSON.stringify(backup);
}
export async function decryptBackup(contents: string, password: string): Promise<BackupData> {
  if (contents.length > MAX_BACKUP) throw new Error('备份文件超过大小限制。');
  try {
    const backup: EncryptedBackup = JSON.parse(contents);
    if (backup.format !== 'relay-desk-local' || backup.version !== 1) throw new Error();
    const salt = decode(backup.salt); const iv = decode(backup.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error();
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('relay-desk-local:1') }, await key(password, salt), decode(backup.ciphertext));
    const data = JSON.parse(new TextDecoder().decode(raw));
    if (typeof data.database !== 'string' || typeof data.master_key !== 'string' || decode(data.master_key).length !== 32 || !atob(data.database.slice(0, 24)).startsWith('SQLite format 3\0')) throw new Error();
    return { database: data.database, master_key: data.master_key };
  } catch { throw new Error('备份密码不正确，或文件损坏／格式不兼容。'); }
}
