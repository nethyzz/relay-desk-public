import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';

test('Cloudflare resource limit pages produce a readable service error without leaking HTML', async t => {
 t.mock.method(globalThis,'fetch',async () => new Response('<html><title>Worker exceeded resource limits | Cloudflare</title><p>private-response-marker</p></html>',{status:503,headers:{'Content-Type':'text/html'}}));
 await assert.rejects(api('panel'),error => {
  assert.match((error as Error).message,/执行资源.*HTTP 503/);
  assert.ok(!(error as Error).message.includes('private-response-marker'));
  assert.ok(!(error as Error).message.includes('字符串与预期模式')); return true;
 });
});
test('HTML gateways, invalid JSON and JSON API errors are safely distinguished', async t => {
 const mock=t.mock.method(globalThis,'fetch',async () => new Response('<html>Unavailable</html>',{status:503}));
 await assert.rejects(api('panel'),/面板服务暂时不可用.*503/);
 mock.mock.mockImplementation(async () => new Response('invalid', {status:200}));
 await assert.rejects(api('panel'),/无效响应.*200/);
 mock.mock.mockImplementation(async () => Response.json({error:'今日请求预算不足'},{status:429}));
 await assert.rejects(api('runs','POST',{targetIds:['one']}),/今日请求预算不足/);
});
test('failed writes are never automatically retried and network failures are readable', async t => {
 let calls=0;
 t.mock.method(globalThis,'fetch',async () => { calls++; throw new TypeError('Load failed'); });
 await assert.rejects(api('runs','POST',{targetIds:['one']}),/无法连接面板服务/);
 assert.equal(calls,1);
});
test('JSON reads and writes retain authentication, body and request cancellation', async t => {
 t.mock.method(globalThis,'fetch',async (url: string,options: RequestInit) => {
  assert.equal(url,'/api/targets'); assert.equal(options.credentials,'same-origin');
  const headers = options.headers as Record<string,string>;
  assert.equal(headers.Accept,'application/json'); assert.equal(headers['Content-Type'],'application/json');
  assert.equal(options.body,JSON.stringify({name:'新模型'})); assert.ok(options.signal instanceof AbortSignal);
  return Response.json({id:'saved'});
 });
 assert.deepEqual(await api('targets','POST',{name:'新模型'}),{id:'saved'});
});
