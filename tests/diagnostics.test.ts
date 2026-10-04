import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, fingerprintReason, reportIssues } from '../src/diagnostics.ts';
import { safeReport } from '../worker/domain.ts';

test('HTTP diagnostics distinguish routes, rate limits, unavailable services and quota', () => {
  assert.equal(classifyError({ http_status: 404 }).title, '接口或模型不存在');
  assert.equal(classifyError({ http_status: 503 }).title, '上游暂时不可用');
  assert.equal(classifyError({ http_status: 503, upstream: { type: 'rate_limit_error' } }).title, '请求被限流');
  assert.equal(classifyError({ http_status: 429 }).title, '请求被限流');
  assert.equal(classifyError({ http_status: 429, upstream: { code: 'insufficient_quota' } }).title, '额度不足');
  assert.equal(classifyError({ http_status: 401 }).title, 'API Key 验证失败');
  assert.equal(classifyError({ http_status: 504 }).title, '上游响应超时');
  assert.equal(classifyError({ code: 'dns_error' }).title, '域名解析失败');
  assert.equal(classifyError({ code: 'proxy_dns_unavailable' }).title, '本地代理未接入');
});
test('final sample errors are grouped with evidence; duplicate event copies are not counted twice', () => {
  const error = { code: 'upstream_http_error', http_status: 404, upstream: { message: 'model does not exist' } };
  const report = { results: [{ error }, { error }], events: [{ type: 'attempt_decision', payload: { error } }] };
  const issues = reportIssues(report, 'failed');
  assert.equal(issues.length, 1); assert.equal(issues[0].count, 2); assert.equal(issues[0].detail, 'model does not exist');
  assert.equal(reportIssues({ events: report.events }, 'failed')[0].httpStatus, 404);
  assert.equal(reportIssues(null, 'failed', '历史没有详情').length, 1);
  assert.equal(reportIssues(null, 'running').length, 0);
  assert.equal(reportIssues({}, 'timed_out')[0].code, 'execution_timeout');
});
test('early failure diagnostics survive sanitization and every preview/export field is redacted', () => {
  const secret = 'private-runner-test-key';
  const clean = safeReport({ failure: 'dns_error', diagnostics: [{ code: 'dns_error', stage: 'address_check', message: 'echo ' + secret }], api_key: secret, events: [{ message: 'Bearer some-really-long-credential' }] }, [secret]);
  assert.ok(!JSON.stringify(clean).includes(secret)); assert.ok(!JSON.stringify(clean).includes('some-really-long-credential'));
  const issues = reportIssues(clean, 'failed');
  assert.equal(issues.length, 1); assert.equal(issues[0].stage, 'address_check');
  assert.equal(issues[0].detail, 'echo [REDACTED]');
  assert.equal(fingerprintReason('no_threshold'), '没有候选模型达到判定线');
});
