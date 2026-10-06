import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const operation = process.argv[2] || 'doctor';
const directory = resolve('.app-build');
mkdirSync(directory, { recursive: true });
const env = { ...process.env, CARGO_HOME: resolve(directory, 'cargo'), CARGO_TARGET_DIR: resolve(directory, 'target'), GRADLE_USER_HOME: resolve(directory, 'gradle'), ANDROID_USER_HOME: resolve(directory, 'android-user'), npm_config_cache: resolve(directory, 'npm-cache'), PATH: resolve(directory, 'cargo/bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH };
if (existsSync(resolve(directory, 'rustup/settings.toml'))) env.RUSTUP_HOME = resolve(directory, 'rustup');
const jdk = resolve(directory, 'jdk/Contents/Home');
if (existsSync(jdk)) { env.JAVA_HOME = jdk; env.PATH = resolve(jdk, 'bin') + ':' + env.PATH; }
const sdk = resolve(directory, 'android-sdk');
if (existsSync(sdk)) { env.ANDROID_HOME = sdk; env.ANDROID_SDK_ROOT = sdk; }
const ndk = resolve(sdk, 'ndk/28.2.13676358');
if (existsSync(resolve(ndk, 'source.properties'))) env.NDK_HOME = ndk;
function command(program, args, options = {}) {
  const child = spawnSync(program, args, { env, stdio: 'inherit', ...options });
  if (child.status !== 0) throw new Error('应用构建步骤失败，请查看上面的诊断。');
}
try {
  if (operation === 'doctor') {
    const available = (program, args) => spawnSync(program, args, { env, stdio: 'ignore' }).status === 0;
    const androidRoot = env.ANDROID_SDK_ROOT || env.ANDROID_HOME;
    const platforms = androidRoot && resolve(androidRoot, 'platforms');
    const ndks = androidRoot && resolve(androidRoot, 'ndk');
    const androidSdk = !!(platforms && existsSync(platforms) && readdirSync(platforms).some(name => existsSync(resolve(platforms, name, 'android.jar'))));
    const androidNdk = !!(env.NDK_HOME && existsSync(resolve(env.NDK_HOME, 'source.properties')) || ndks && existsSync(ndks) && readdirSync(ndks).some(name => existsSync(resolve(ndks, name, 'source.properties'))));
    console.log(JSON.stringify({ platform: process.platform, node: process.version, rust: available('rustc', ['--version']), fullXcode: process.platform === 'darwin' && available('xcrun', ['--find', 'simctl']), java: available('java', ['-version']), androidSdk, androidSdkConfigured: !!androidRoot, androidNdk, cacheDirectory: directory, desktopDataSeparateFromProject: true }, null, 2));
  } else if (operation === 'prepare') command(process.execPath, ['scripts/prepare-app-runtime.mjs']);
  else if (operation === 'verify') { command(process.execPath, ['scripts/prepare-app-runtime.mjs']); command(process.execPath, ['scripts/verify-app-runtime.mjs']); }
  else if (operation === 'web') {
    command(process.execPath, ['scripts/prepare-app-runtime.mjs']);
    command(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.native.config.ts']);
  } else if (operation === 'preview') {
    command(process.execPath, ['scripts/prepare-app-runtime.mjs']);
    command(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.native.config.ts']);
  } else if (['build', 'dev', 'android', 'ios'].includes(operation)) {
    if (operation === 'ios' && (process.platform !== 'darwin' || spawnSync('xcrun', ['--find', 'simctl'], { env, stdio: 'ignore' }).status !== 0)) {
      throw new Error('iPhone 构建需要完整 Xcode。请先安装并选择 Xcode，再运行 app:ios；本脚本不会自动安装系统开发工具。');
    }
    if ((operation === 'android' || operation === 'ios') && process.argv[3] === 'init') {
      command(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', operation, ...process.argv.slice(3)]);
      command(process.execPath, ['scripts/configure-mobile-app.mjs', operation]);
      process.exit(0);
    }
    command(process.execPath, ['scripts/app.mjs', 'web']);
    if (operation === 'android' || operation === 'ios') command(process.execPath, ['scripts/configure-mobile-app.mjs', operation]);
    if (!existsSync('src-tauri/icons/icon.icns')) command(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'icon', 'public/icon-512.png', '-o', 'src-tauri/icons']);
    const args = [operation, ...process.argv.slice(3)];
    if (operation === 'build' && process.platform === 'win32' && !args.includes('--bundles')) args.push('--bundles', 'nsis');
    if (operation === 'dev' || ((operation === 'android' || operation === 'ios') && process.argv[3] === 'dev')) {
      const frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.native.config.ts'], { env, stdio: 'inherit' });
      const native = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', ...args], { env, stdio: 'inherit' });
      const stop = () => { frontend.kill('SIGTERM'); native.kill('SIGTERM'); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      native.on('exit', code => { frontend.kill('SIGTERM'); process.exitCode = code || 0; });
    } else {
      command(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', ...args]);
      if (operation === 'build' || process.argv[3] === 'build') command(process.execPath, ['scripts/collect-app-artifacts.mjs', operation]);
    }
  } else if (operation === 'clean') {
    command(process.execPath, ['scripts/clean-app-build.mjs', ...process.argv.slice(3)]);
  } else throw new Error('未知应用命令。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
