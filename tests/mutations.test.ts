import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveAndRefresh } from '../src/mutations.ts';

test('a successful save followed by a failed panel refresh stays successful and is never resubmitted', async () => {
 let writes=0;let refreshes=0;
 const saved = await saveAndRefresh(async () => {writes++;return {id:'saved-model'};},async () => {refreshes++;throw new Error('HTTP 503');});
 assert.deepEqual(saved,{result:{id:'saved-model'},refreshError:'HTTP 503'});
 assert.equal(writes,1);assert.equal(refreshes,1);
});
test('a rejected save is reported as a write failure and never triggers panel refresh', async () => {
 let refreshes=0;
 await assert.rejects(saveAndRefresh(async () => {throw new Error('请先保存站点');},async () => {refreshes++;}),/请先保存站点/);
 assert.equal(refreshes,0);
});
