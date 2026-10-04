import { BASELINES, type PanelData } from './shared.ts';

export function detectionOverview(data: Pick<PanelData, 'runs' | 'run_sets'>, now = Date.now()) {
 const runs = [...new Map(data.runs.map(run => [run.id, run])).values()];
 const active = runs.filter(run => run.status === 'queued' || run.status === 'running');
 const activeIds = new Set(active.map(run => run.id));
 const sets = [...(data.run_sets || [])].sort((a, b) => b.created_at - a.created_at);
 const activeSets = sets.filter(set => set.run_ids.some(id => activeIds.has(id)));
 const batchIds = new Set(active.map(run => run.batch_id));
 const selectedIds = new Set(activeSets.flatMap(set => set.run_ids));
 let selected = runs.filter(run => batchIds.has(run.batch_id) || selectedIds.has(run.id));
 let selectedSets = activeSets;
 if (!active.length) {
  const recent = sets.find(set => set.created_at <= now && now - set.created_at < 86400000 && set.run_ids.length);
  if (!recent) return null;
  const ids = new Set(recent.run_ids); selected = runs.filter(run => ids.has(run.id)); selectedSets = [recent];
  // Incomplete history cannot be presented as a fully finished selection.
  if (selected.length !== ids.size) return null;
 }
 if (!selected.length) return null;
 let resolved = 0; let planned = 0;
 for (const run of selected) {
  const progress = { ...run.progress, ...run.report?.progress };
  const fallback = BASELINES[run.snapshot.protocol]?.counts[run.snapshot.tier] || 1;
  const weight = positive(run.snapshot.logical_requests) || positive(progress.planned) || fallback;
  const ended = run.status !== 'queued' && run.status !== 'running';
  const completed = typeof progress.logical_completed === 'number' && Number.isFinite(progress.logical_completed) ? Math.max(0, Math.min(weight, progress.logical_completed)) : 0;
  // A failed/timed-out target is finished work, not a successful detection.
  resolved += ended ? weight : run.status === 'running' ? completed : 0; planned += weight;
 }
 const queued = selected.filter(run => run.status === 'queued').length;
 const running = selected.filter(run => run.status === 'running' && !run.stop_requested_at).length;
 const stopping = selected.filter(run => run.status === 'running' && !!run.stop_requested_at).length;
 const stopped = selected.filter(run => run.status === 'cancelled').length;
 const finished = selected.length - queued - running - stopping;
 const failed = selected.filter(run => run.status === 'failed' || run.status === 'timed_out').length;
 return { runs: selected, sets: selectedSets, total: selected.length, queued, running, stopping, stopped, finished, failed, active: queued + running + stopping, percent: Math.min(active.length ? 99 : 100, Math.floor(resolved / planned * 100)) };
}
function positive(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0; }

export function detectionMailState(data: Pick<PanelData, 'mail'>, overview: NonNullable<ReturnType<typeof detectionOverview>>) {
 if (!data.mail.enabled) return { label: '邮件通知已关闭', state: 'off', detail: '检测结果仍会保存到报告。' };
 const sets = overview.sets.filter(set => set.source === 'scheduled' ? data.mail.mode !== 'daily' : data.mail.notify_manual);
 if (!sets.length) return { label: '本批次不即时发送邮件', state: 'off', detail: overview.sets.some(set => set.source === 'scheduled') && data.mail.mode === 'daily' ? '自动检测按每天汇总策略发送。' : '手动检测邮件通知已关闭。' };
 if (overview.active) return { label: '等待整批结束后汇总', state: 'waiting', detail: '全部目标结束后发送汇总邮件，失败、超时及已暂停目标也会纳入报告。' };
 if (overview.stopped === overview.total) return { label: '本批次全部已暂停', state: 'off', detail: '样本与请求数已保留，本批次不发送即时汇总邮件。' };
 const notices = sets.map(set => set.notice);
 if (notices.some(notice => notice?.status === 'failed')) return { label: '邮件发送失败', state: 'failed', detail: notices.find(notice => notice?.status === 'failed')?.error || '检测报告已保存，请检查邮件设置。' };
 if (notices.some(notice => notice?.status === 'processing')) return { label: '正在发送汇总邮件', state: 'sending', detail: '报告已保存，邮件正在连接邮箱服务器并提交。' };
 if (notices.some(notice => notice?.status === 'pending') || sets.some(set => !set.notice && !set.ended_at)) return { label: '汇总邮件等待发送', state: 'waiting', detail: '检测已结束，邮件还在准备或等待执行器。' };
 const issued = notices.filter(notice => !!notice);
 if (issued.length && issued.every(notice => notice.status === 'sent')) return { label: '汇总邮件已提交', state: 'sent', detail: '邮箱服务器已接受邮件；最终到达收件箱可能稍有延迟。' };
 return { label: '本批次无需发送邮件', state: 'off', detail: '通知已取消，或自动检测结果没有触发异常及恢复提醒。' };
}
