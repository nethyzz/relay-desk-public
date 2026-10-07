import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const manifest = JSON.parse(await readFile(join(root, 'HANDOFF-MANIFEST.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('交接清单格式无效。');
  const seen = new Set();
  for (const item of manifest.files) {
    const parts = typeof item.path === 'string' ? item.path.split('/') : [];
    if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))
        || seen.has(item.path.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('交接清单包含无效文件路径或校验值。');
    seen.add(item.path.toLowerCase());
    let path = root;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error(`交接文件类型不符合预期：${item.path}`);
    }
    const bytes = await readFile(path);
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`交接文件缺失或已经改变：${item.path}`);
  }
  console.log(`交接校验通过：${manifest.files.length} 个文件的大小与 SHA-256 一致。可开始 Windows 开发；修改源码后清单不再代表新的版本。`);
} catch (error) {
  console.error(error.code === 'ENOENT' ? '交接文件缺失，请完整解压后运行校验。' : String(error.message || error));
  process.exitCode = 1;
}
