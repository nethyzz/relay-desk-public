import { ApiError, type Env } from './types.ts';
import { loginCredentials } from './password.ts';
const encoder = new TextEncoder();
function bytes(input: string) { return Uint8Array.from(atob(input), c => c.charCodeAt(0)); }
export function base64(input: Uint8Array) { return btoa(String.fromCharCode(...input)); }
export function randomToken() { return base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(c => c.toString(16).padStart(2, '0')).join(''); }
export async function encrypt(value: string, env: Env, context: string) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const key = await crypto.subtle.importKey('raw', bytes(env.MASTER_KEY), 'AES-GCM', false, ['encrypt']);
 const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(value));
 return `${base64(iv)}.${base64(new Uint8Array(result))}`;
}
export async function decrypt(value: string, env: Env, context: string) {
 const [iv, cipher] = value.split('.');
 const key = await crypto.subtle.importKey('raw', bytes(env.MASTER_KEY), 'AES-GCM', false, ['decrypt']);
 return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: encoder.encode(context) }, key, bytes(cipher)));
}
export function localRequest(request: Request, env: Env) { return env.DEV_MODE === 'local' && ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname); }
async function hmacKey(env: Env) { if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new ApiError('登录尚未配置', 503); return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function sign(value: Record<string, unknown>, env: Env) { const payload = base64(encoder.encode(JSON.stringify(value))); return `${payload}.${base64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(payload))))}`; }
export async function unsign(value: string, env: Env): Promise<Record<string, unknown> | null> {
 try { const [payload, sig] = value.split('.'); if (!payload || !sig || !await crypto.subtle.verify('HMAC', await hmacKey(env), bytes(sig), encoder.encode(payload))) return null; const result = JSON.parse(new TextDecoder().decode(bytes(payload))); return typeof result.expires === 'number' && result.expires > Date.now() ? result : null; } catch { return null; }
}
export function cookie(request: Request, name: string) { return request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }
export async function session(request: Request, env: Env) {
 if (localRequest(request, env)) return { id: 'local', login: '本地预览', local: true };
 const data = await unsign(cookie(request, '__Host-relay_session'), env);
 const credentials = loginCredentials(env);
 return data && credentials && data.type === 'password' && data.id === credentials.email && data.revision === credentials.revision ? data : null;
}
export function sameOrigin(request: Request, env: Env) { if (request.headers.get('Origin') !== env.APP_ORIGIN) throw new ApiError('请求来源不正确，请从面板内操作', 403); }
export function textValue(value: unknown, label: string, max = 256) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/.test(value)) throw new ApiError(`${label}格式不正确`); return value.trim(); }
export function integerValue(value: unknown, label: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(`${label}需在 ${min}–${max} 之间`); return value; }
export function publicUrl(value: unknown) {
 const raw = textValue(value, 'API 地址', 2048); let url: URL;
 try { url = new URL(raw); } catch { throw new ApiError('请输入完整的 HTTPS API 地址'); }
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new ApiError('只支持无凭据、无查询参数的公网 HTTPS 地址');
 const host = url.hostname.toLowerCase();
 if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost') || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || /^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.includes('[')) throw new ApiError('只支持公网域名，不能访问本机或内网地址');
 return url.href.replace(/\/+$/, '');
}
function publicIp(value: string) {
 if (value.includes(':')) {
  let normalized: string;
  try { normalized = new URL(`https://[${value}]/`).hostname.slice(1, -1); } catch { return false; }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':').map(v => parseInt(v, 16)) : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':').map(v => parseInt(v, 16)) : [];
  const parts = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  if (parts.length !== 8 || parts.some(v => !Number.isInteger(v))) return false;
  const mapped = parts.slice(0, 5).every(v => v === 0) && parts[5] === 0xffff;
  const translated = parts.slice(0, 4).every(v => v === 0) && parts[4] === 0xffff && parts[5] === 0;
  const nat64 = parts[0] === 0x64 && parts[1] === 0xff9b && parts.slice(2, 6).every(v => v === 0);
  if (mapped || translated || nat64) return publicIp(`${parts[6] >>> 8}.${parts[6] & 255}.${parts[7] >>> 8}.${parts[7] & 255}`);
  return parts[0] !== 0 && (parts[0] & 0xfe00) !== 0xfc00 && (parts[0] & 0xffc0) !== 0xfe80 && (parts[0] & 0xffc0) !== 0xfec0 && (parts[0] & 0xff00) !== 0xff00 && !normalized.startsWith('2001:db8:');
 }
 const parts = value.split('.').map(Number);
 if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return false;
 const [a, b, c] = parts;
 return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224);
}
export async function ensurePublicHostname(value: string) {
 const hostname = new URL(value).hostname;
 const responses = await Promise.all([1, 28].map(type => fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })));
 if (responses.some(response => !response.ok)) throw new ApiError('无法验证 API 地址的公网 DNS', 400);
 const answers = (await Promise.all(responses.map(response => response.json() as Promise<{ Answer?: { type?: number; data?: string }[] }>))).flatMap(value => value.Answer || []).filter(answer => (answer.type === 1 || answer.type === 28) && typeof answer.data === 'string');
 const addresses = answers.map(answer => answer.data as string);
 if (!addresses.length || addresses.some(address => !publicIp(address))) throw new ApiError('API 地址没有解析到公网 IP', 400);
}
export async function verifyOidc(request: Request, env: Env) {
 if (localRequest(request, env) && env.LOCAL_RUNNER_TOKEN && request.headers.get('X-Local-Runner') === env.LOCAL_RUNNER_TOKEN) return { run_id: 'local-' + (request.headers.get('X-Local-Run') || 'runner') };
 const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
 try {
  const parts = token.split('.'); if (parts.length !== 3) throw Error();
  const decode = (s: string) => JSON.parse(new TextDecoder().decode(bytes(s.replace(/-/g, '+').replace(/_/g, '/'))));
  const header = decode(parts[0]); const claims = decode(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw Error();
  const now = Math.floor(Date.now() / 1000);
  if (![claims.exp, claims.nbf, claims.iat].every(v => typeof v === 'number' && Number.isFinite(v)) || typeof claims.run_id !== 'string' || !claims.run_id) throw Error();
  if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== env.APP_ORIGIN || claims.exp < now || claims.nbf > now + 30 || claims.iat > now + 30 || now - claims.iat > 900 || claims.repository !== env.GITHUB_REPOSITORY || String(claims.repository_id) !== env.GITHUB_REPOSITORY_ID || claims.ref !== (env.GITHUB_REF || 'refs/heads/main') || claims.event_name !== 'workflow_dispatch' || claims.workflow_ref !== `${env.GITHUB_REPOSITORY}/.github/workflows/${env.GITHUB_WORKFLOW || 'detector.yml'}@${env.GITHUB_REF || 'refs/heads/main'}`) throw Error();
  const jwks = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks');
  if (!jwks.ok) throw Error();
  const keyData = (await jwks.json() as { keys: (JsonWebKey & { kid?: string })[] }).keys.find(k => k.kid === header.kid);
  if (!keyData) throw Error();
  const key = await crypto.subtle.importKey('jwk', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2].replace(/-/g, '+').replace(/_/g, '/')), encoder.encode(parts[0] + '.' + parts[1]))) throw Error();
  return claims;
 } catch { throw new ApiError('执行器身份验证失败', 401); }
}
