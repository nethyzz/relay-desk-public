export type Tier = 'low' | 'medium' | 'high';
export type Protocol = 'gpt' | 'claude' | 'gpt-chat' | 'claude-chat';
export type Verdict = 'match' | 'mismatch' | 'insufficient';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out';
export interface Group { id: string; name: string; created_at: number }
export interface Endpoint { id: string; group_id: string; name: string; station_name: string; base_url: string; credential_saved: boolean; created_at: number; updated_at: number }
export interface Target { id: string; endpoint_id: string; name: string; protocol: Protocol; request_model: string; claimed_model: string; tier: Tier; created_at: number }
export interface Schedule { target_id: string; enabled: boolean; kind: 'interval' | 'daily'; interval_minutes: number; daily_time: string; tier: Tier; next_due: number | null; last_error: string | null }
export interface Fingerprint { verdict: Verdict; model: string | null; claimed_model: string; matches: Record<string, number>; thresholds: Record<string, number>; valid_samples: number; planned_samples: number; reasons: string[]; partial_samples?: boolean }
export interface Report { fingerprint?: Fingerprint; benchmark?: { id: string; version: string; content_sha256: string }; progress?: Record<string, unknown>; operational_status?: string; failure?: string | null; endpoint?: string; request_model?: string; claimed_model?: string; tier?: Tier; results?: unknown[]; [key: string]: unknown }
export interface Run { id: string; batch_id: string; target_id: string; status: RunStatus; source: string; created_at: number; started_at: number | null; ended_at: number | null; attempts: number; reserved_attempts: number; progress: Record<string, unknown> | null; report: Report | null; snapshot: RunSnapshot; error: string | null }
export interface RunSnapshot { target_name: string; endpoint_name: string; station_name?: string; base_url: string; group_name: string; protocol: Protocol; request_model: string; claimed_model: string; tier: Tier; baseline_id: string; baseline_version: string; baseline_sha256: string; logical_requests: number; retry_budget: number; endpoint_id: string }
export interface MailSettings { enabled: boolean; notify_manual: boolean; mode: 'changes' | 'daily' | 'all'; host: string; port: number; username: string; from: string; to: string; credential_saved: boolean }
export interface Limits { daily_requests: number; monthly_minutes: number }
export interface MailTest { id: string; status: string; created_at: number; sent_at: number | null; error: string | null }
export interface RunSet { id: string; source: string; created_at: number; ended_at: number | null; run_ids: string[]; notice: MailTest | null }
export interface RunPreset { id: string; name: string; target_ids: string[]; created_at: number; updated_at: number }
export interface PanelData { groups: Group[]; endpoints: Endpoint[]; targets: Target[]; schedules: Schedule[]; runs: Run[]; run_sets?: RunSet[]; run_presets?: RunPreset[]; limits: Limits; mail: MailSettings; usage: { daily_requests: number; monthly_minutes: number }; execution_ready: boolean; local: boolean; preview_only?: boolean; last_mail_error: string | null; last_mail_test: MailTest | null }
export const TIER_LABEL: Record<Tier, string> = { low: '快速', medium: '标准', high: '深度' };
export const PROTOCOL_LABEL: Record<Protocol, string> = { gpt: 'GPT · Responses', claude: 'Claude · Messages', 'gpt-chat': 'GPT · Chat 兼容', 'claude-chat': 'Claude · Chat 兼容' };
export const VERDICT_LABEL: Record<Verdict, string> = { match: '支持申报模型', mismatch: '强指向其他模型', insufficient: '证据不足' };
export interface Baseline { id: string; version: string; sha256: string; models: string[]; counts: Record<Tier, number> }
export const BASELINES: Record<Protocol, Baseline> = {
  gpt: { id: 'meow-gpt-other-cap98-efficient', version: '4.5.4-predictive.20261003.1', sha256: '9273dc33374e8be234a950437f4b7238228fbe096f051b1f210e46297c612362', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6-sol'], counts: { low: 32, medium: 64, high: 128 } },
  claude: { id: 'meow-claude-other-cap98-efficient', version: '4.5.4-predictive.20260924.1', sha256: 'df005a15ef72cc805b57fd0caf8c8f6b99496ca37d73c6cc759adaa43158ef8c', models: ['claude-fable-5.1', 'claude-opus-5.5', 'claude-sonnet-5', 'claude-haiku-4.5'], counts: { low: 48, medium: 72, high: 120 } },
  'gpt-chat': { id: 'meow-gpt-chat-compatible', version: '4.5.4-chat.20261003.1', sha256: '7510f4901b741a592f889f7bd2926cfd74e5d5919875279e8056f5e74cf709c7', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6-sol'], counts: { low: 32, medium: 64, high: 128 } },
  'claude-chat': { id: 'meow-claude-chat-compatible', version: '4.5.4-chat.20260924.1', sha256: 'db6728ff00d28f58ed21079ce66a82f70ba226a6530c52c5630fddd5cbf963da', models: ['claude-fable-5.1', 'claude-opus-5.5', 'claude-sonnet-5', 'claude-haiku-4.5'], counts: { low: 48, medium: 72, high: 120 } },
};
export const LEGACY_BASELINES: Partial<Record<Protocol, Baseline>> = {
 'gpt': { id: 'meow-gpt-other-cap98-efficient', version: '4.5.4-predictive.20260924.2', sha256: '98f8d12c83100352addf44db15d8b57aa183338a4fb5f83ba30ffdbc06d78612', models: ['gpt-6-sol'], counts: { low: 32, medium: 64, high: 128 } },
 'gpt-chat': { id: 'meow-gpt-chat-compatible', version: '4.5.4-chat.20260924.2', sha256: '5c835e5b6646359e33f3f56663b712f214eaa7eda1108088f3a3764bc0b4db72', models: ['gpt-6-sol'], counts: { low: 32, medium: 64, high: 128 } },
};
export function baselineFor(protocol: Protocol, claimedModel: string): Baseline { const legacy = LEGACY_BASELINES[protocol]; return legacy?.models.includes(claimedModel) ? legacy : BASELINES[protocol]; }
export function defaultRequestModel(protocol: Protocol, claimedModel: string, baseUrl: string): string {
 if (!protocol.startsWith('claude') || !claimedModel) return claimedModel;
 try { const url = new URL(baseUrl); if (url.hostname === 'openrouter.ai' && url.pathname.replace(/\/$/, '') === '/api/v1') return 'anthropic/' + claimedModel; } catch { /* A saved endpoint is validated separately. */ }
 return claimedModel.replace(/(\d)\.(?=\d)/g, '$1-');
}
export function plannedRequests(protocol: Protocol, tier: Tier) { const logical = BASELINES[protocol].counts[tier]; return { logical, maximum: logical + Math.ceil(logical / 2) }; }
export function comparisonKey(run: Run) { const s = run.snapshot; const b = run.report?.benchmark; return [run.target_id, s.request_model, s.claimed_model, s.protocol, s.tier, b?.id || s.baseline_id, b?.version || s.baseline_version, b?.content_sha256 || s.baseline_sha256].join('|'); }
export function appliesTo(run: Run, target: Target, endpoint: Endpoint) { const s = run.snapshot; return s.endpoint_id === endpoint.id && s.base_url === endpoint.base_url && s.protocol === target.protocol && s.request_model === target.request_model && s.claimed_model === target.claimed_model; }
export type TargetFilter = { kind: 'group' | 'station'; value: string };
export function endpointsInScope(endpoints: Endpoint[], filter: TargetFilter) { return endpoints.filter(endpoint => filter.value === 'all' || (filter.kind === 'group' ? endpoint.group_id : endpoint.base_url) === filter.value); }
export function targetsInScope(targets: Target[], endpoints: Endpoint[], filter: TargetFilter) {
 const selected = new Set(endpointsInScope(endpoints, filter).map(endpoint => endpoint.id));
 return targets.filter(target => selected.has(target.endpoint_id));
}
export function targetsInGroup(targets: Target[], endpoints: Endpoint[], groupId: string) { return targetsInScope(targets, endpoints, { kind: 'group', value: groupId }); }
export function recipientAddresses(value: string) { return [...new Set(value.trim().split(/[\s,;，；]+/).filter(Boolean).map(address => address.toLowerCase()))]; }
