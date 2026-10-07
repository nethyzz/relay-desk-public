import { BASELINES, defaultRequestModel, type Endpoint, type PanelData, type Protocol, type Schedule, type Target } from './shared.ts';

export type CloneData = Pick<PanelData, 'endpoints' | 'targets' | 'schedules'>;
export interface CloneSource { source_id: string; request_model?: string; configuration?: string }
export interface CloneInput { operation_id: string; claimed_model: string; sources: CloneSource[] }
export interface CloneResult { claimed_model: string; created: number; reused: number; target_ids: string[] }
export type CloneStatus = 'ready' | 'existing' | 'duplicate' | 'incompatible' | 'missing';
export interface ClonePreview {
 sourceId: string;
 source?: Target;
 endpoint?: Endpoint;
 schedule?: Schedule;
 requestModel: string;
 status: CloneStatus;
 existingId?: string;
 supported: boolean;
}
export function modelFamily(model: string): 'gpt' | 'claude' | null {
 const known = Object.entries(BASELINES).find(([, baseline]) => baseline.models.includes(model));
 if (known) return known[0].startsWith('claude') ? 'claude' : 'gpt';
 return /^(?:anthropic\/)?claude[-.]/i.test(model) ? 'claude' : /^(?:openai\/)?gpt[-.]/i.test(model) ? 'gpt' : null;
}
export function compatibleCopy(protocol: Protocol, model: string) {
 const family = modelFamily(model);
 return !family || (protocol.startsWith('claude') ? 'claude' : 'gpt') === family;
}
export function monitorSettings(schedule?: Schedule) {
 return { enabled: !!schedule?.enabled, kind: schedule?.kind || 'interval', interval_minutes: schedule?.interval_minutes ?? 360, daily_time: schedule?.daily_time || '09:00', tier: schedule?.tier || 'low' };
}
export function cloneSignature(target: Pick<Target, 'endpoint_id' | 'name' | 'protocol' | 'request_model' | 'claimed_model' | 'tier'>, schedule?: Schedule) {
 return JSON.stringify([target.endpoint_id, target.name, target.protocol, target.request_model, target.claimed_model, target.tier, monitorSettings(schedule)]);
}
export function cloneConfiguration(target: Target, endpoint: Endpoint, schedule?: Schedule) {
 const monitor = monitorSettings(schedule);
 return JSON.stringify([target.endpoint_id, target.name, target.protocol, target.request_model, target.claimed_model, target.tier, endpoint.base_url, endpoint.group_id, endpoint.station_name, endpoint.name, endpoint.updated_at, monitor.enabled ? 1 : 0, monitor.kind, monitor.interval_minutes, monitor.daily_time, monitor.tier]);
}
export function clonePreviews(data: CloneData, sources: CloneSource[], claimedModel: string): ClonePreview[] {
 const endpoints = new Map(data.endpoints.map(endpoint => [endpoint.id, endpoint]));
 const targets = new Map(data.targets.map(target => [target.id, target]));
 const schedules = new Map(data.schedules.map(schedule => [schedule.target_id, schedule]));
 const existing = new Map<string, string>();
 for (const target of data.targets) if (endpoints.has(target.endpoint_id)) {
  const signature = cloneSignature(target, schedules.get(target.id));
  if (!existing.has(signature)) existing.set(signature, target.id);
 }
 const selected = new Set<string>();
 return sources.map(item => {
  const source = targets.get(item.source_id); const endpoint = source && endpoints.get(source.endpoint_id);
  const schedule = source && schedules.get(source.id);
  const requestModel = source && endpoint ? item.request_model ?? defaultRequestModel(source.protocol, claimedModel, endpoint.base_url) : '';
  const preview: ClonePreview = { sourceId: item.source_id, source, endpoint, schedule, requestModel, supported: !!source && BASELINES[source.protocol].models.includes(claimedModel), status: 'ready' };
  if (!source || !endpoint) return { ...preview, status: 'missing' };
  if (!compatibleCopy(source.protocol, claimedModel)) return { ...preview, status: 'incompatible' };
  const signature = cloneSignature({ ...source, claimed_model: claimedModel, request_model: requestModel }, schedule);
  const existingId = existing.get(signature);
  if (existingId) return { ...preview, status: 'existing', existingId };
  if (selected.has(signature)) return { ...preview, status: 'duplicate' };
  selected.add(signature);
  return preview;
 });
}
export function detectionModelGroups(targets: Target[]) {
 const counts = new Map<string, number>();
 for (const target of targets) counts.set(target.claimed_model, (counts.get(target.claimed_model) || 0) + 1);
 const models = new Set([...Object.values(BASELINES).flatMap(baseline => baseline.models), ...counts.keys()]);
 return [...models].map(model => ({ model, count: counts.get(model) || 0 }));
}
