"""Package published sources and pinned app resources, excluding local data."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
app_version = json.loads((root / 'src-tauri/tauri.conf.json').read_text())['version']
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
files = {root / name for name in tracked if name}
for path in files:
    relative = path.relative_to(root)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Source package rejects symbolic links and missing files')
    if any(part in {'.git', '.local', '.venv', 'node_modules', 'target', 'gen', '__pycache__', '.DS_Store'} for part in relative.parts):
        raise RuntimeError('Source package rejects private data and build caches')
    if path.name in {'.env', '.dev.vars', 'secrets.json', 'panel.sqlite'} or path.suffix in {'.p12', '.pfx', '.mobileprovision', '.keystore', '.jks'}:
        raise RuntimeError('Source package rejects credentials and signing material')

manifest = json.loads((root / 'runner/upstream.json').read_text())
files.update((root / '.vendor/gpt56_vnext').glob('*.py'))
for baseline in [*manifest['baselines'].values(), *manifest.get('archived_baselines', {}).values()]:
    path = root / '.vendor/benchmarks' / (baseline['id'] + '--' + baseline['version'] + '.meow.json')
    if hashlib.sha256(path.read_bytes()).hexdigest() != baseline['sha256']:
        raise RuntimeError('Pinned benchmark checksum mismatch')
    files.add(path)
for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
    files.add(root / '.vendor' / name)

runtime = root / '.app-build/native-public'
if not (runtime / 'runtime/engine.json').exists():
    raise RuntimeError('Run npm run app:prepare before packaging sources')
files.update(path for path in runtime.rglob('*') if path.is_file())
directory = root / 'release'
directory.mkdir(exist_ok=True)
archive = directory / f'relay-desk-v{version}-native-source.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
    for path in sorted(files):
        if path.is_symlink():
            raise RuntimeError('Source package rejects symbolic links')
        bundle.write(path, f'relay-desk-{version}/' + path.relative_to(root).as_posix())
metadata = {
    'platform': 'source', 'source_version': version, 'app_version': app_version,
    'files': [{'name': archive.name, 'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}],
    'source_files': len(files),
}
(directory / 'build-source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'archive': archive.name, 'files': len(files), 'megabytes': round(archive.stat().st_size / 1048576, 1)}, ensure_ascii=False))
