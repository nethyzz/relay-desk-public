import { appliesTo, type Endpoint, type Run, type Target } from './shared.ts';

export const TARGET_SORTS = {
 default: { label: '默认顺序', hint: '按添加时间排列。' },
 name: { label: '按名称', hint: '按名称排列，数字按大小比较。' },
 result: { label: '按检测结果', hint: '请求失败／超时 → 模型不符 → 证据不足 → 支持申报模型 → 已暂停 → 尚未检测；使用最近已结束的检测结果。' },
 status: { label: '按当前状态', hint: '检测中／正在停止 → 排队中 → 失败／超时 → 检测结束／已暂停 → 尚未检测。' },
 recent: { label: '按最近检测时间', hint: '最近开始检测的目标在前，尚未检测的目标在后。' },
} as const;
export type TargetSort = keyof typeof TARGET_SORTS;
const nameOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function isTargetSort(value: unknown): value is TargetSort { return typeof value === 'string' && Object.hasOwn(TARGET_SORTS, value); }
export function latestTargetRun(target: Target, endpoints: Endpoint[], runs: Run[], finished = false) {
 const endpoint = endpoints.find(e => e.id === target.endpoint_id);
 if (!endpoint) return undefined;
 return runs.filter(r => r.target_id === target.id && (!(finished) || !['queued', 'running'].includes(r.status)) && (['queued', 'running'].includes(r.status) || appliesTo(r, target, endpoint))).reduce<Run | undefined>((latest, r) => !latest || r.created_at > latest.created_at ? r : latest, undefined);
}
function resultRank(run?: Run) {
 if (!run) return 5;
 if (run.status === 'cancelled') return 4;
 if (run.status !== 'completed') return 0;
 return ({ mismatch: 1, insufficient: 2, match: 3 })[run.report?.fingerprint?.verdict || 'insufficient'];
}
function statusRank(run?: Run) { return run ? ({ running: 0, queued: 1, failed: 2, timed_out: 2, completed: 3, cancelled: 3 })[run.status] : 4; }
export function sortTargets(targets: Target[], endpoints: Endpoint[], runs: Run[], order: TargetSort) {
 const evidence = new Map(targets.map(t => [t.id, { current: latestTargetRun(t, endpoints, runs), finished: latestTargetRun(t, endpoints, runs, true) }]));
 return [...targets].sort((a, b) => {
  const first = evidence.get(a.id)!; const second = evidence.get(b.id)!;
  const difference = order === 'result' ? resultRank(first.finished) - resultRank(second.finished)
   : order === 'status' ? statusRank(first.current) - statusRank(second.current)
   : order === 'recent' ? (second.current?.created_at || 0) - (first.current?.created_at || 0)
   : order === 'default' ? a.created_at - b.created_at : 0;
  return difference || nameOrder.compare(a.name, b.name) || a.created_at - b.created_at || a.id.localeCompare(b.id);
 });
}
