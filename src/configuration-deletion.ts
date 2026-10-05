import type { PanelData } from './shared.ts';
import { isActive } from './run-control.ts';

export type ConfigurationSelection = { kind: 'station' | 'key' | 'model'; id: string };
export function configurationDeletion(data: PanelData, selection: ConfigurationSelection) {
 const target = selection.kind === 'model' ? data.targets.find(value => value.id === selection.id) : undefined;
 const anchor = data.endpoints.find(value => value.id === (target?.endpoint_id || selection.id));
 if (!anchor || selection.kind === 'model' && !target) return null;
 const profiles = selection.kind === 'station' ? data.endpoints.filter(value => value.base_url === anchor.base_url) : [anchor];
 const profileIds = new Set(profiles.map(profile => profile.id));
 const models = target ? [target] : data.targets.filter(value => profileIds.has(value.endpoint_id));
 const targetIds = models.map(value => value.id);
 const selectedIds = new Set(targetIds);
 const endpointIds = selection.kind === 'model' ? [] : profiles.map(value => value.id);
 const label = selection.kind === 'station' ? '中转站' : selection.kind === 'key' ? 'Key 配置' : '检测模型';
 const path = `${selection.kind === 'station' ? 'stations' : selection.kind === 'key' ? 'endpoints' : 'targets'}/${encodeURIComponent(selection.id)}`;
 return {
  label, name: target?.name || (selection.kind === 'station' ? anchor.station_name : anchor.name),
  station: anchor.station_name, baseUrl: anchor.base_url, profiles, models, path,
  activeRuns: data.runs.filter(run => selectedIds.has(run.target_id) && isActive(run)),
  enabledSchedules: data.schedules.filter(schedule => selectedIds.has(schedule.target_id) && schedule.enabled).length,
  emptiedPresets: (data.run_presets || []).filter(preset => preset.target_ids.length > 0 && preset.target_ids.every(id => selectedIds.has(id))).length,
  request: { confirm: true, targetIds, endpointIds, ...(selection.kind !== 'model' ? { previous_base_url: anchor.base_url } : {}) },
 };
}
