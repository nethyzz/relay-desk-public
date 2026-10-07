"""Create a Windows development handoff from current source and pinned assets.

After build-cache cleanup, recover runtime assets in memory from the previously
verified source archive. Never package user databases or development toolchains.
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'release'
VERSION = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())['version']
OUTPUT = RELEASE / f'Relay-Desk-{VERSION}-Windows-development.zip'
RUNTIME_PREFIX = '.app-build/native-public/'
EXCLUDED = {'__pycache__', 'gen', 'target', 'build', 'node_modules', '.DS_Store', '.pytest_cache'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_owned_file(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Source package requires regular files, without symbolic links')
    return path.read_bytes()


def runtime_assets():
    directory = ROOT / RUNTIME_PREFIX
    if (directory / 'runtime/engine.json').is_file():
        assets = {}
        for path in directory.rglob('*'):
            if path.is_symlink():
                raise RuntimeError('Runtime package rejects symbolic links')
            if path.is_file() and path.name != '.DS_Store':
                assets[RUNTIME_PREFIX + path.relative_to(directory).as_posix()] = read_owned_file(path)
        return assets
    manifest = json.loads(read_owned_file(RELEASE / 'build-source.json'))
    for entry in manifest['files']:
        name = entry['name']
        if Path(name).name != name or not name.endswith('.zip'):
            continue
        archive = RELEASE / name
        contents = read_owned_file(archive)
        if len(contents) != entry['bytes'] or digest(contents) != entry['sha256']:
            raise RuntimeError('Previous source archive failed its size or SHA-256 check')
        with zipfile.ZipFile(archive) as bundle:
            if bundle.testzip():
                raise RuntimeError('Previous source archive failed its CRC check')
            assets = {}
            for info in bundle.infolist():
                parts = PurePosixPath(info.filename).parts
                if not parts or parts[0] not in {'Relay-Desk-Local', 'Relay-Desk-Windows', 'relay-desk-' + json.loads((ROOT / 'package.json').read_text())['version']}:
                    continue
                relative = '/'.join(parts[1:])
                if relative.startswith(RUNTIME_PREFIX) and not info.is_dir():
                    if '..' in parts or '\\' in relative or relative in assets:
                        raise RuntimeError('Previous runtime archive contains unsafe paths')
                    assets[relative] = bundle.read(info)
            if RUNTIME_PREFIX + 'runtime/engine.json' in assets:
                return assets
    raise RuntimeError('Prepare the app runtime or supply the verified previous source archive')


def main():
    files = {}
    for name in ['src', 'worker', 'migrations', 'apps', 'scripts', 'runner', 'tests', 'public', 'LICENSES', 'src-tauri', 'docs']:
        directory = ROOT / name
        if directory.is_symlink():
            raise RuntimeError('Source directories cannot be symbolic links')
        for path in directory.rglob('*'):
            relative = path.relative_to(ROOT)
            if any(part in EXCLUDED for part in relative.parts):
                continue
            if path.is_symlink():
                raise RuntimeError('Source package rejects symbolic links')
            if path.is_file():
                files[relative.as_posix()] = read_owned_file(path)
    for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.native.config.ts', 'vite.config.ts', 'index.html', '.gitignore', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'CHANGELOG.md']:
        files[name] = read_owned_file(ROOT / name)
    for path in sorted((ROOT / '.vendor/gpt56_vnext').glob('*.py')):
        files[path.relative_to(ROOT).as_posix()] = read_owned_file(path)
    for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        files['.vendor/' + name] = read_owned_file(ROOT / '.vendor' / name)
    upstream = json.loads(files['runner/upstream.json'])
    baselines = [*upstream['baselines'].values(), *upstream.get('archived_baselines', {}).values()]
    for baseline in baselines:
        relative = '.vendor/benchmarks/' + baseline['id'] + '--' + baseline['version'] + '.meow.json'
        data = read_owned_file(ROOT / relative)
        if digest(data) != baseline['sha256']:
            raise RuntimeError('Pinned detector baseline failed SHA-256 verification')
        files[relative] = data

    runtime = runtime_assets()
    lock_path = RUNTIME_PREFIX + 'runtime/pyodide-lock.json'
    lock = json.loads(runtime[lock_path])
    selected = set()

    def select(name):
        if name not in selected:
            selected.add(name)
            for dependency in lock['packages'][name]['depends']:
                select(dependency)

    for name in ['numpy', 'httpx', 'sqlite3', 'ssl']:
        select(name)
    core = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'package.json']
    for name in core:
        relative = RUNTIME_PREFIX + 'runtime/' + name
        if relative not in runtime:
            raise RuntimeError('Pinned runtime is incomplete')
        npm_source = ROOT / 'node_modules/pyodide' / name
        if name != 'package.json' and npm_source.exists() and runtime[relative] != read_owned_file(npm_source):
            raise RuntimeError('Runtime base assets do not match the installed pinned Pyodide package')
    for name in selected:
        package = lock['packages'][name]
        relative = RUNTIME_PREFIX + 'runtime/' + package['file_name']
        if relative not in runtime or digest(runtime[relative]) != package['sha256']:
            raise RuntimeError('Pinned Python runtime dependency failed SHA-256 verification')

    # Regenerate the detector bundle from current source, even when its binary
    # dependencies were recovered from a previous archive.
    engine_files = {key.removeprefix('.vendor/'): value.decode('utf8') for key, value in sorted(files.items()) if key.startswith('.vendor/gpt56_vnext/') or key.startswith('.vendor/benchmarks/')}
    engine_files['relay_runtime.py'] = files['apps/local/relay_runtime.py'].decode('utf8')
    engine_files['relay_mail.py'] = files['runner/mail.py'].decode('utf8')
    migrations = [{'name': key.removeprefix('migrations/'), 'sql': value.decode('utf8')} for key, value in sorted(files.items()) if key.startswith('migrations/') and key.endswith('.sql')]
    engine = {'version': upstream['engine_version'], 'engine_ref': upstream['engine_ref'], 'files': engine_files, 'migrations': migrations}
    runtime[RUNTIME_PREFIX + 'runtime/engine.json'] = json.dumps(engine, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    allowed = {RUNTIME_PREFIX + 'runtime/' + name for name in core}
    allowed.add(RUNTIME_PREFIX + 'runtime/engine.json')
    allowed.update(RUNTIME_PREFIX + 'runtime/' + lock['packages'][name]['file_name'] for name in selected)
    files.update({key: value for key, value in runtime.items() if key in allowed})
    for key, value in list(files.items()):
        if key.startswith('LICENSES/'):
            files[RUNTIME_PREFIX + key] = value
    for name in ['icon.svg', 'icon-192.png', 'icon-512.png']:
        files[RUNTIME_PREFIX + name] = files['public/' + name]
    files[RUNTIME_PREFIX + 'THIRD_PARTY_NOTICES.md'] = files['THIRD_PARTY_NOTICES.md']

    files['docs/web-project-reference.md'] = (
        '# 原网页工程 README 参考\n\n'
        '下面是当前网页工程的 README，供了解共享功能和历史部署方式。'
        'Windows 本地构建请以 windows-handoff.md 为准；个人 Cloudflare 配置与部署权限未随包提供。\n\n'
    ).encode('utf8') + read_owned_file(ROOT / 'README.md')
    files['README.md'] = f'''# Relay Desk Windows 开发交接包

应用版本 {VERSION}，公开源码发行版 {json.loads((ROOT / 'package.json').read_text())['version']}。这一层就是工程根目录。

本包包含共享工程、固定 meow 4.5.4 检测器与六份基准、离线运行资源、依赖锁、测试与第三方许可，新增模型筛选、搜索和跨站点配置复制。Windows 从源码构建，尚无 EXE；Mac 1.1.1 已单独发布。

1. 完整解压，打开包含 package.json 的工程目录。
2. 运行 `node scripts/verify-handoff.mjs` 检查逐文件大小与 SHA-256。
3. 按 [Windows 开发交接](docs/windows-handoff.md) 准备 MSVC / Rust / WebView2，构建并原生验收。
4. 可使用 [开发任务示例](docs/windows-codex-prompt.md)；已完成的共享验证见 [验证记录](docs/windows-handoff-validation.md)。

原检测内核作者为 [chen-006 及贡献者](https://github.com/chen-006/meow-llm-detector)，面板与集成由 [nethyzz](https://github.com/nethyzz) 维护。保留 [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md) 和 LICENSES/，遵守 PolyForm Noncommercial 1.0.0 的非商业用途限制。

包内没有用户数据库、API Key、邮箱授权码或私人部署权限。运行资源离线提供，开发依赖仍需另行安装。个人配置请在原 App 导出密码加密备份，再在完成的 Windows App 内恢复；密码单独输入。

[共享项目介绍与使用方法](docs/web-project-reference.md) · [安装与备份](docs/cross-platform-apps.md)

HANDOFF-MANIFEST.json 记录打包快照，源码修改后需重新运行 scripts/collect-windows-handoff.py 生成新清单。

Required Notice: Copyright 2026 chen-006 and contributors. Original project: https://github.com/chen-006/gpt56_api_detector
'''.encode('utf8')
    lowered = set()
    for name in files:
        parts = PurePosixPath(name).parts
        if name.startswith('/') or not parts or '..' in parts or '\\' in name or ':' in name or name.lower() in lowered:
            raise RuntimeError('Handoff paths must be unique and Windows-compatible')
        lowered.add(name.lower())
    timestamp = datetime.now(timezone.utc).isoformat()
    checksum = {'schema': 1, 'created_at': timestamp, 'application_version': VERSION, 'intended_platform': 'Windows', 'contains_user_data': False, 'windows_binary_built': False, 'files': [{'path': key, 'bytes': len(value), 'sha256': digest(value)} for key, value in sorted(files.items())]}
    files['HANDOFF-MANIFEST.json'] = (json.dumps(checksum, ensure_ascii=False, indent=2) + '\n').encode('utf8')
    RELEASE.mkdir(exist_ok=True)
    temporary = OUTPUT.with_suffix('.zip.pending')
    if temporary.exists() or temporary.is_symlink() or OUTPUT.is_symlink():
        raise RuntimeError('Output staging path exists or points elsewhere; review it first')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for name, contents in sorted(files.items()):
                bundle.writestr('Relay-Desk-Windows/' + name, contents)
        with zipfile.ZipFile(temporary) as bundle:
            if bundle.testzip() or len(bundle.namelist()) != len(files):
                raise RuntimeError('New handoff archive failed integrity verification')
        os.replace(temporary, OUTPUT)
    finally:
        if temporary.exists():
            temporary.unlink()
    metadata = {'created_at': timestamp, 'platform': 'windows-development-handoff', 'source_files': len(files), 'files': [{'name': OUTPUT.name, 'bytes': OUTPUT.stat().st_size, 'sha256': digest(OUTPUT.read_bytes())}], 'windows_binary_built': False}
    (RELEASE / 'build-source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'archive': str(OUTPUT), 'files': len(files), 'megabytes': round(OUTPUT.stat().st_size / 1048576, 2), 'sha256': metadata['files'][0]['sha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
