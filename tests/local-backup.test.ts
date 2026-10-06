import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptBackup, encryptBackup } from '../apps/local/backup.ts';
const data = { database: btoa('SQLite format 3\0' + 'private records'), master_key: btoa('a'.repeat(32)) };
test('portable backup round trip preserves the database and decryption key', async () => {
  const contents = await encryptBackup(data, 'example backup password');
  assert.ok(!contents.includes(data.master_key));
  assert.ok(!contents.includes('private records'));
  assert.deepEqual(await decryptBackup(contents, 'example backup password'), data);
});
test('wrong password and tampering cannot restore a backup', async () => {
  const contents = await encryptBackup(data, 'example backup password');
  await assert.rejects(decryptBackup(contents, 'wrong password'));
  const altered = JSON.parse(contents); altered.ciphertext = 'AAAA' + altered.ciphertext.slice(4);
  await assert.rejects(decryptBackup(JSON.stringify(altered), 'example backup password'));
  await assert.rejects(decryptBackup('{"format":"another-app"}', 'example backup password'));
});
test('backup encryption requires a password long enough to protect saved credentials', async () => {
  await assert.rejects(encryptBackup(data, 'short'));
});
