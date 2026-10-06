import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const operation = process.argv[2] || 'build';
const directory = resolve('release');
await mkdir(directory, { recursive: true });
await cp('docs/cross-platform-apps.md', join(directory, '安装与卸载说明.md'));
if (process.platform === 'darwin' && operation === 'build') await cp('scripts/uninstall-macos.command', join(directory, '卸载清理.command'));
const roots = operation === 'android' ? ['src-tauri/gen/android/app/build/outputs'] : operation === 'ios' ? ['src-tauri/gen/apple/build'] : ['.app-build/target/release/bundle'];
const files = [];
function run(program, args, message) {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(message);
}
async function copyMacApp(source, destination) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source], '应用签名校验失败，请先完成 bundle.macOS.signingIdentity 配置。');
  const temporary = await mkdtemp(join(directory, '.collect-'));
  try {
    const staged = join(temporary, basename(destination));
    run('/usr/bin/ditto', ['--norsrc', '--noextattr', source, staged], '应用复制失败');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], '复制后的应用签名校验失败');
    try {
      if ((await lstat(destination)).isSymbolicLink()) throw new Error('拒绝覆盖指向其他位置的应用符号链接');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    // Finder metadata may be added to an app in a synced Documents folder.
    // It is not an app resource and cannot be included in a signed archive.
    for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
      const result = spawnSync('/usr/bin/xattr', ['-dr', attribute, destination], { encoding: 'utf8' });
      if (result.status !== 0 && !result.stderr.includes('No such xattr')) throw new Error('应用打包元数据清理失败');
    }
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination], '导出后的应用签名校验失败');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function visit(path) {
  let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const source = join(path, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      const destination = join(directory, entry.name);
      if (process.platform === 'darwin') await copyMacApp(source, destination);
      else await cp(source, destination, { recursive: true });
      if (process.platform === 'darwin') {
        const archive = destination + '.zip';
        run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', destination, archive], '应用压缩失败'); files.push(archive);
      }
    } else if (entry.isDirectory()) await visit(source);
    else if (/\.(dmg|exe|msi|apk|aab|ipa)$/i.test(entry.name)) { const destination = join(directory, entry.name); await cp(source, destination); files.push(destination); }
  }
}
for (const root of roots) await visit(resolve(root));
const manifest = { created_at: new Date().toISOString(), platform: operation === 'build' ? process.platform : operation, files: await Promise.all(files.map(async path => ({ name: basename(path), bytes: (await stat(path)).size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))) };
await writeFile(join(directory, `build-${manifest.platform}.json`), JSON.stringify(manifest, null, 2));
console.log(files.length ? '安装文件已收集到 release/；构建缓存可以单独清理。' : '未找到安装文件，请查看该平台构建结果与签名要求。');
