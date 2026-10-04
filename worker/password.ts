import { ApiError, type Env } from './types.ts';
import { derivePasswordProof, fromBase64, PASSWORD_ITERATIONS, toBase64, type PasswordParameters } from '../src/password.ts';
interface Credentials extends PasswordParameters { version: number; email: string; pepper: string; verifier: string; revision: string }
function proofMessage(proof: string) {
 const value = fromBase64(proof);
 if (value.length !== 32) throw new Error('Invalid proof');
 const prefix = new TextEncoder().encode('Relay-Desk/password/v1:');
 const message = new Uint8Array(prefix.length + value.length); message.set(prefix); message.set(value, prefix.length); return message;
}
async function verificationKey(pepper: string) { return crypto.subtle.importKey('raw', fromBase64(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export function loginCredentials(env: Env): Credentials | null {
 try {
  const value = JSON.parse(env.LOGIN_CREDENTIALS || '') as Credentials;
  if (value.version !== 1 || typeof value.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.email !== value.email.trim().toLowerCase() || value.iterations !== PASSWORD_ITERATIONS || !/^[a-f0-9]{32}$/.test(value.revision) || fromBase64(value.salt).length !== 16 || fromBase64(value.pepper).length !== 32 || fromBase64(value.verifier).length !== 32 || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) return null;
  return value;
 } catch { return null; }
}
// PBKDF2 runs in the browser; the Free Worker only verifies a secret-keyed HMAC.
// The stored verifier cannot itself be replayed as a login proof.
export async function createLoginCredentials(email: string, password: string): Promise<Credentials> {
 email = email.trim().toLowerCase();
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 1024) throw new Error('请输入有效邮箱和至少 12 位密码');
 const salt = toBase64(crypto.getRandomValues(new Uint8Array(16))); const pepper = toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const proof = await derivePasswordProof(password, { salt, iterations: PASSWORD_ITERATIONS });
 const verifier = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', await verificationKey(pepper), proofMessage(proof))));
 const revision = [...crypto.getRandomValues(new Uint8Array(16))].map(c => c.toString(16).padStart(2, '0')).join('');
 return { version: 1, email, salt, iterations: PASSWORD_ITERATIONS, pepper, verifier, revision };
}
export async function verifyLoginProof(email: unknown, proof: unknown, credentials: Credentials) {
 if (typeof email !== 'string' || email.length > 254 || typeof proof !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(proof)) return false;
 try {
  const valid = await crypto.subtle.verify('HMAC', await verificationKey(credentials.pepper), fromBase64(credentials.verifier), proofMessage(proof));
  return valid && email.trim().toLowerCase() === credentials.email;
 } catch { return false; }
}
export async function reserveLoginAttempt(request: Request, env: Env) {
 const now = Date.now(); const window = 15 * 60000;
 const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
 const privateKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
 const hashedIp = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', privateKey, new TextEncoder().encode('login-ip:' + ip))));
 const buckets = [{ key: 'ip:' + hashedIp, limit: 5 }, { key: 'global', limit: 100 }];
 const existing = (await env.DB.prepare('SELECT bucket,attempts,reset_at FROM login_limits WHERE bucket IN (?,?)').bind(...buckets.map(b => b.key)).all<{ bucket: string; attempts: number; reset_at: number }>()).results;
 const blocked = buckets.some(b => existing.some(r => r.bucket === b.key && r.reset_at > now && r.attempts >= b.limit));
 if (blocked) throw new ApiError('登录尝试过于频繁，请在 15 分钟后重试。', 429);
 const result = await env.DB.batch([
  env.DB.prepare('DELETE FROM login_limits WHERE reset_at<=?').bind(now),
  ...buckets.map(b => env.DB.prepare('INSERT INTO login_limits(bucket,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=login_limits.attempts+1 WHERE login_limits.attempts<?').bind(b.key, now + window, b.limit)),
 ]);
 if (result.slice(1).some(r => !r.meta.changes)) throw new ApiError('登录尝试过于频繁，请在 15 分钟后重试。', 429);
 return buckets[0].key;
}
export async function clearLoginAttempts(bucket: string, env: Env) {
 await env.DB.batch([
  env.DB.prepare('DELETE FROM login_limits WHERE bucket=?').bind(bucket),
  env.DB.prepare("UPDATE login_limits SET attempts=MAX(0,attempts-1) WHERE bucket='global'").bind(),
 ]);
}
