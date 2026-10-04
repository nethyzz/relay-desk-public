import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestTargetRun, sortTargets, isTargetSort } from '../src/target-sorting.ts';
import { targetsInScope, type Endpoint, type Run, type Target } from '../src/shared.ts';

const endpoints = [
 { id: 'e', base_url: 'https://api.example.com/v1', group_id: 'g' },
 { id: 'other', base_url: 'https://other.example.com/v1', group_id: 'other-group' },
] as Endpoint[];
function target(id: string, name = id, created_at = 1): Target { return { id, name, created_at, endpoint_id: 'e', protocol: 'gpt', request_model: 'alias', claimed_model: 'gpt-6-sol', tier: 'low' }; }
function run(t: Target, status: Run['status'], time: number, verdict: string = 'match'): Run {
 return { id: `${t.id}-${time}`, target_id: t.id, status, created_at: time, snapshot: { endpoint_id: t.endpoint_id, base_url: 'https://api.example.com/v1', protocol: t.protocol, request_model: t.request_model, claimed_model: t.claimed_model }, report: { fingerprint: { verdict, valid_samples: 32 } } } as Run;
}
test('numeric name ordering and saved sort validation do not mutate the target list or filter scope', () => {
 const targets = [target('15', '0.15'), target('3', '0.03'), target('8', '0.08'), { ...target('outside', '0.01'), endpoint_id: 'other' }];
 const scoped = targetsInScope(targets, endpoints, { kind: 'group', value: 'g' });
 assert.deepEqual(sortTargets(scoped, endpoints, [], 'name').map(t => t.id), ['3', '8', '15']);
 assert.deepEqual(targets.map(t => t.id), ['15', '3', '8', 'outside']);
 assert.equal(isTargetSort('status'), true); assert.equal(isTargetSort('constructor'), false); assert.equal(isTargetSort(null), false);
});
test('result sorting keeps the last finished evidence during new tests and ignores obsolete configuration', () => {
 const targets = ['match', 'mismatch', 'insufficient', 'failed', 'new', 'obsolete'].map(id => target(id));
 const runs = [run(targets[0], 'completed', 1), run(targets[1], 'completed', 1, 'mismatch'), run(targets[2], 'completed', 1, 'insufficient'), run(targets[3], 'failed', 1), run(targets[1], 'running', 2), { ...run(targets[5], 'failed', 1), snapshot: { ...run(targets[5], 'failed', 1).snapshot, request_model: 'old-model' } }];
 assert.deepEqual(sortTargets(targets, endpoints, runs, 'result').map(t => t.id), ['failed', 'mismatch', 'insufficient', 'match', 'new', 'obsolete']);
 assert.equal(latestTargetRun(targets[1], endpoints, runs)?.status, 'running');
 assert.equal(latestTargetRun(targets[1], endpoints, runs, true)?.report?.fingerprint?.verdict, 'mismatch');
});
test('status and recent sorting use current progress and update after completion', () => {
 const targets = ['done', 'queued', 'running', 'failed', 'new'].map(id => target(id));
 const runs = [run(targets[0], 'completed', 2), run(targets[1], 'queued', 4), run(targets[2], 'running', 5), run(targets[3], 'timed_out', 3)];
 assert.deepEqual(sortTargets(targets, endpoints, runs, 'status').map(t => t.id), ['running', 'queued', 'failed', 'done', 'new']);
 assert.deepEqual(sortTargets(targets, endpoints, runs, 'recent').map(t => t.id), ['running', 'queued', 'failed', 'done', 'new']);
 const ended = runs.map(r => r.target_id === 'running' ? { ...r, status: 'completed' as const } : r);
 assert.deepEqual(sortTargets(targets, endpoints, ended, 'status').map(t => t.id), ['queued', 'failed', 'done', 'running', 'new']);
});
