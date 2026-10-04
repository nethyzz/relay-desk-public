import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectionMailState, detectionOverview } from '../src/detection-progress.ts';
import { BASELINES, type MailSettings, type Run, type RunSet } from '../src/shared.ts';

const now = 1791110000000;
function run(id: string, status: Run['status'], completed = 0, planned = 32, batch = 'batch-a'): Run {
 return { id, batch_id: batch, target_id: 'target-' + id, status, source: 'manual', created_at: now - 60000, started_at: status === 'queued' ? null : now - 50000, ended_at: ['queued', 'running'].includes(status) ? null : now - 1000, attempts: 0, reserved_attempts: planned * 1.5, progress: { planned, logical_completed: completed, http_attempts: completed + 12 }, report: null, snapshot: { target_name: id, station_name: 'fixture relay', endpoint_name: 'fixture key', base_url: 'https://example.com/v1', group_name: 'fixture group', endpoint_id: 'endpoint', protocol: 'gpt', tier: 'low', claimed_model: 'gpt-6.1-sol', request_model: 'gpt-6.1-sol', baseline_id: BASELINES.gpt.id, baseline_version: BASELINES.gpt.version, baseline_sha256: BASELINES.gpt.sha256, logical_requests: planned, retry_budget: planned / 2 }, error: null };
}
function set(ids: string[], source = 'manual'): RunSet { return { id: 'set-a', source, created_at: now - 60000, ended_at: null, run_ids: ids, notice: null }; }
const mail: MailSettings = { enabled: true, notify_manual: true, mode: 'all', host: 'smtp.example.com', port: 465, username: '', from: '', to: '', credential_saved: true };

test('global progress retains finished targets and weights mixed tiers by logical work, not retries', () => {
 const runs = [run('one', 'completed', 32), run('two', 'running', 64, 128), run('three', 'queued', 30)];
 const progress = detectionOverview({ runs }, now)!;
 assert.equal(progress.percent, 50); assert.equal(progress.finished, 1); assert.equal(progress.running, 1); assert.equal(progress.queued, 1); assert.equal(progress.total, 3);
 // Returning a finished target cannot shrink the denominator or regress its work.
 runs[1] = run('two', 'completed', 64, 128);
 assert.equal(detectionOverview({ runs }, now)!.percent, 83);
});
test('failed and timed-out targets finish work without being counted as passed samples', () => {
 const progress = detectionOverview({ runs: [run('one', 'failed', 0), run('two', 'timed_out', 5), run('three', 'running', 16)] }, now)!;
 assert.equal(progress.percent, 83); assert.equal(progress.finished, 2); assert.equal(progress.failed, 2);
});
test('all active batches join one overview while unrelated history is excluded and run IDs deduplicate', () => {
 const a = run('one', 'running', 16); const b = run('two', 'queued', 0, 32, 'batch-b'); const c = run('three', 'completed', 32, 32, 'batch-c');
 const progress = detectionOverview({ runs: [a, b, c, run('old', 'completed', 32, 32, 'unrelated'), a], run_sets: [set(['one', 'three'])] }, now)!;
 assert.equal(progress.total, 3); assert.equal(progress.percent, 50); assert.deepEqual(new Set(progress.runs.map(r => r.id)), new Set(['one', 'two', 'three']));
});
test('progress clamps bad data and reserves 100 percent for submitted final reports', () => {
 const a = run('one', 'running', 1000); assert.equal(detectionOverview({ runs: [a] }, now)!.percent, 99);
 a.report = { progress: { logical_completed: NaN, planned: Infinity } }; assert.equal(detectionOverview({ runs: [a] }, now)!.percent, 0);
 a.report = { progress: { logical_completed: -1 } }; assert.equal(detectionOverview({ runs: [a] }, now)!.percent, 0);
 a.report = { progress: {} }; a.progress = { logical_completed: 8 }; assert.equal(detectionOverview({ runs: [a] }, now)!.percent, 25);
});
test('recent fully closed selection remains at 100 percent for mail tracking; old or missing history hides', () => {
 const group = { ...set(['one', 'two']), ended_at: now - 500 };
 const runs = [run('one', 'failed'), run('two', 'completed')];
 assert.equal(detectionOverview({ runs, run_sets: [group] }, now)!.percent, 100);
 assert.equal(detectionOverview({ runs: [runs[0]], run_sets: [group] }, now), null);
 assert.equal(detectionOverview({ runs, run_sets: [{ ...group, created_at: now - 86400000 }] }, now), null);
});
test('mail waiting, sending, accepted and failure are distinct from detection completion', () => {
 const group: RunSet & { notice: NonNullable<RunSet['notice']> } = { ...set(['one']), ended_at: now - 1000, notice: { id: 'notice', status: 'pending', created_at: now - 1000, sent_at: null, error: null } };
 const progress = detectionOverview({ runs: [run('one', 'completed')], run_sets: [group] }, now)!;
 assert.equal(detectionMailState({ mail }, progress).state, 'waiting');
 group.notice.status = 'processing'; assert.equal(detectionMailState({ mail }, progress).state, 'sending');
 group.notice.status = 'sent'; assert.equal(detectionMailState({ mail }, progress).state, 'sent');
 group.notice.status = 'failed'; group.notice.error = 'controlled SMTP error'; assert.equal(detectionMailState({ mail }, progress).detail, group.notice.error);
 group.notice.status = 'sent'; assert.equal(detectionMailState({ mail: { ...mail, enabled: false } }, progress).state, 'off');
 assert.equal(detectionMailState({ mail: { ...mail, notify_manual: false } }, progress).state, 'off');
});
test('automatic change-only decisions without a notice do not appear stuck waiting', () => {
 const progress = detectionOverview({ runs: [run('one', 'completed')], run_sets: [{ ...set(['one'], 'scheduled'), ended_at: now - 1000 }] }, now)!;
 assert.equal(detectionMailState({ mail: { ...mail, mode: 'changes' } }, progress).state, 'off');
 assert.equal(detectionMailState({ mail: { ...mail, mode: 'daily' } }, progress).state, 'off');
});
