export interface PasswordParameters { salt: string; iterations: number }
export const PASSWORD_ITERATIONS = 600_000;
export function toBase64(value: Uint8Array) { return btoa(String.fromCharCode(...value)); }
export function fromBase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function derivePasswordProof(password: string, parameters: PasswordParameters) {
 if (parameters.iterations !== PASSWORD_ITERATIONS || fromBase64(parameters.salt).length !== 16) throw new Error('登录配置不正确，请刷新页面重试');
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
 const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(parameters.salt), iterations: parameters.iterations }, key, 256);
 return toBase64(new Uint8Array(result));
}
