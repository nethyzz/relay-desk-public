import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canStop, runsToStop } from '../src/run-control.ts';
import { BASELINES, targetsInScope, type Endpoint, type MailSettings, type Run, type Target } from '../src/shared.ts';
import { detectionMailState, detectionOverview } from '../src/detection-progress.ts';
import { reportIssues } from '../src/diagnostics.ts';

function run(id: string, target_id: string, status: Run['status'], stop_requested_at: number | null = null): Run {
 return { id, target_id, status, stop_requested_at, batch_id: 'batch', source: 'manual', created_at: Date.now(), started_at: null, ended_at: null, attempts: 0, reserved_attempts: 48, report: null, error: null, snapshot: { logical_requests: 32, protocol: 'gpt', tier: 'low', target_name: id, endpoint_name: '示例 Key', base_url: 'https://a.example.com', group_name: '示例分组', endpoint_id: 'one', request_model: 'gpt-6.1-sol', claimed_model: 'gpt-6.1-sol', baseline_id: BASELINES.gpt.id, baseline_version: BASELINES.gpt.version, baseline_sha256: BASELINES.gpt.sha256, retry_budget: 16 }, progress: { logical_completed: 8 } };
}
test('individual, selected, group and station stops only include their exact active runs and ignore pending stops', () => {
 const endpoints = [{ id: 'one', base_url: 'https://a.example.com', group_id: '08' }, { id: 'two', base_url: 'https://a.example.com', group_id: '15' }, { id: 'three', base_url: 'https://b.example.com', group_id: '08' }] as Endpoint[];
 const targets = [{ id: 'a', endpoint_id: 'one' }, { id: 'b', endpoint_id: 'two' }, { id: 'c', endpoint_id: 'three' }] as Target[];
 const runs = [run('a-old', 'a', 'completed'), run('a-current', 'a', 'running'), run('b-current', 'b', 'queued'), run('c-current', 'c', 'running'), run('d-current', 'd', 'running', 123), run('e-stopped', 'e', 'cancelled')];
 const scope = (kind: 'group' | 'station', value: string) => targetsInScope(targets, endpoints, { kind, value }).map(target => target.id);
 assert.deepEqual(runsToStop(runs, ['a']).map(run => run.id), ['a-current']);
 assert.deepEqual(runsToStop(runs, scope('group', '08')).map(run => run.id), ['a-current', 'c-current']);
 assert.deepEqual(runsToStop(runs, scope('station', 'https://a.example.com')).map(run => run.id), ['a-current', 'b-current']);
 assert.deepEqual(runsToStop(runs, scope('group', 'all')).map(run => run.id), ['a-current', 'b-current', 'c-current']);
 assert.deepEqual(runsToStop(runs, ['b', 'c', 'd', 'e']).map(run => run.id), ['b-current', 'c-current']);
 assert.equal(canStop(undefined), false); assert.equal(canStop(runs[4]), false);
});
test('stopping stays active until acknowledgement; paused targets count as ended and never as failed', () => {
 const runs = [run('one', 'a', 'running', Date.now()), run('two', 'b', 'cancelled'), run('three', 'c', 'running')];
 const progress = detectionOverview({ runs })!;
 assert.equal(progress.active, 2); assert.equal(progress.running, 1); assert.equal(progress.stopping, 1); assert.equal(progress.stopped, 1); assert.equal(progress.finished, 1); assert.equal(progress.failed, 0); assert.equal(progress.percent, 50);
 const group = { id: 'set', source: 'manual', created_at: Date.now(), ended_at: Date.now(), run_ids: runs.map(run => run.id), notice: null };
 const ended = detectionOverview({ runs: runs.map(run => ({ ...run, status: 'cancelled' as const })), run_sets: [group] })!;
 assert.equal(ended.percent, 100); assert.equal(ended.active, 0);
 const mail: MailSettings = { enabled: true, notify_manual: true, mode: 'all', host: 'smtp.example.com', port: 465, username: '', from: '', to: '', credential_saved: false };
 assert.equal(detectionMailState({ mail }, ended).label, '本批次全部已暂停');
});
test('intentional pause evidence is not presented as a network error', () => {
 assert.deepEqual(reportIssues({ events: [{ payload: { error: { code: 'user_paused' } } }], results: [{ error: { code: 'user_paused' } }] }, 'cancelled'), []);
 assert.equal(reportIssues({ results: [{ error: { http_status: 429, code: 'rate_limit' } }, { error: { code: 'user_paused' } }] }, 'cancelled')[0].title, '请求被限流');
});
