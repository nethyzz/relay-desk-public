import type { Run } from './shared.ts';

export function isActive(run: Run) { return run.status === 'queued' || run.status === 'running'; }
export function canStop(run?: Run) { return !!run && isActive(run) && !run.stop_requested_at; }
export function runsToStop(runs: Run[], targetIds: string[]) {
 const selected = new Set(targetIds);
 return runs.filter(run => selected.has(run.target_id) && canStop(run));
}
