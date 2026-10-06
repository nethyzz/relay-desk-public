import { lstat, readdir, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = await realpath('.');
const paths = ['.app-build/target', '.app-build/npm-cache', '.app-build/gradle', '.app-build/tools', '.app-build/cargo', '.app-build/rustup', '.app-build/android-sdk', '.app-build/android-user', '.app-build/jdk', '.app-build/tmp', '.app-build/qa', '.app-build/native-unit-temp', '.app-build/native-python-tests', 'apps/local/__pycache__', 'src-tauri/gen/android/.gradle', 'src-tauri/gen/android/build', 'src-tauri/gen/android/app/build', 'src-tauri/gen/android/buildSrc/.gradle', 'src-tauri/gen/android/buildSrc/build', 'src-tauri/gen/apple/build', 'src-tauri/gen/apple/DerivedData'];
if (process.argv.includes('--all')) paths.push('.app-build/native-public', 'native-dist');
const apply = process.argv.includes('--apply');
async function size(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let total = 0; for (const name of await readdir(path)) total += await size(join(path, name)); return total;
}
for (const relative of paths) {
  const path = resolve(root, relative);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (await realpath(path)) !== path) throw new Error('拒绝清理符号链接目录');
    console.log(`${apply ? '清理' : '预览'}：${relative} · ${(await size(path) / 1024 / 1024).toFixed(1)} MB`);
    if (apply) await rm(path, { recursive: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(apply ? '构建临时目录已按清单清理。安装包、源码及正式数据保留。' : '仅预览。加 --apply 执行；--all 还会清理生成的运行环境和界面构建。');
