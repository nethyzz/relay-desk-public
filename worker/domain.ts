import { BASELINES, plannedRequests, recipientAddresses, type Protocol, type Tier } from '../src/shared.ts';
import { ApiError } from './types.ts';
export function protocolValue(value: unknown): Protocol { if (typeof value !== 'string' || !(value in BASELINES)) throw new ApiError('请选择受支持的请求协议'); return value as Protocol; }
export function tierValue(value: unknown): Tier { if (!['low', 'medium', 'high'].includes(String(value))) throw new ApiError('检测档位不正确'); return value as Tier; }
export function mailRecipients(value: unknown) {
 if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new ApiError('收件邮箱格式不正确');
 const addresses = recipientAddresses(value);
 if (addresses.length > 20) throw new ApiError('最多填写 20 个收件邮箱');
 for (const address of addresses) if (address.length > 254 || !/^[^\s@,;<>:]+@[^\s@,;<>:]+\.[^\s@,;<>:]+$/.test(address)) throw new ApiError('收件邮箱格式不正确，请每行填写一个邮箱或用逗号分隔');
 return addresses.join(', ');
}
export function manualMailEnabled(mail: { notify_manual?: boolean }) { return mail.notify_manual !== false; }
export function supportedModel(protocol: Protocol, model: string) { return BASELINES[protocol].models.includes(model); }
export function shanghaiDay(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
export function shanghaiMonth(now = Date.now()) { return shanghaiDay(now).slice(0, 7); }
export function nextDue(config: { kind: string; interval_minutes: number; daily_time: string }, now = Date.now()) {
 if (config.kind === 'interval') return now + config.interval_minutes * 60000;
 const [hour, minute] = config.daily_time.split(':').map(Number);
 const start = Date.parse(shanghaiDay(now) + 'T00:00:00+08:00');
 const candidate = start + (hour * 60 + minute) * 60000;
 return candidate > now ? candidate : candidate + 86400000;
}
export function requestPlan(protocol: Protocol, tier: Tier) { const p = plannedRequests(protocol, tier); return { logical: p.logical, retry: p.maximum - p.logical, maximum: p.maximum }; }
export function safeReport(report: unknown, secrets: string[]) {
 const allowed = ['schema_version', 'product', 'version', 'session_id', 'updated_at', 'operational_status', 'failure', 'fingerprint', 'progress', 'mode', 'tier', 'claimed_model', 'request_model', 'endpoint', 'site_group', 'benchmark', 'results', 'events', 'diagnostics'];
 if (!report || typeof report !== 'object' || Array.isArray(report)) throw new ApiError('报告格式不正确');
 const clean = Object.fromEntries(Object.entries(report).filter(([key]) => allowed.includes(key)));
 const redact = (value: unknown): unknown => {
  if (typeof value === 'string') {
   for (const secret of secrets) if (secret) value = (value as string).split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]');
   return (value as string).replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[a-zA-Z0-9._-]{12,})/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)]));
  return value;
 };
 const raw = JSON.stringify(redact(clean));
 if (raw.length > 1000000) throw new ApiError('报告过大，请关闭原始响应留存');
 return JSON.parse(raw);
}
