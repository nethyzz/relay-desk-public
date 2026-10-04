"""Download the original, pinned detector. Never reimplement its scoring."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'runner/upstream.json').read_text())

def verify(directory: Path) -> None:
    init = (directory / 'gpt56_vnext/__init__.py').read_text()
    if not re.search(r'__version__\s*=\s*[\'"]' + re.escape(MANIFEST['engine_version']) + r'[\'"]', init):
        raise ValueError('Original detector version does not match the pinned release')
    for item in [*MANIFEST['baselines'].values(), *MANIFEST.get('archived_baselines', {}).values()]:
        path = directory / 'benchmarks' / (item['id'] + '--' + item['version'] + '.meow.json')
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != item['sha256']:
            raise ValueError('Baseline SHA-256 mismatch: ' + item['id'])
        data = json.loads(content)
        if data['id'] != item['id'] or data['version'] != item['version']:
            raise ValueError('Baseline identity mismatch')
        if {tier: sum(data['tiers'][tier]['counts'].values()) for tier in item['counts']} != item['counts']:
            raise ValueError('Baseline request counts do not match the panel')
    source = json.loads((directory / 'source-lock.json').read_text())
    if source['engine_ref'] != MANIFEST['engine_ref'] or source['archive_sha256'] != MANIFEST['engine_archive_sha256']:
        raise ValueError('Original source lock does not match the pinned archive')

def bootstrap(proxy: str | None = None) -> Path:
    destination = ROOT / '.vendor'
    if destination.exists():
        try:
            verify(destination)
            print('原检测器、当前与保留的旧基准校验通过。')
            return destination
        except (OSError, ValueError, KeyError):
            pass
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': proxy, 'http': proxy})) if proxy else urllib.request.build_opener()
    def fetch(url: str, expected_hash: str) -> bytes:
        request = urllib.request.Request(url, headers={'User-Agent': 'Relay-Desk-bootstrap', 'Accept-Encoding': 'identity'})
        for attempt in range(3):
            try:
                with opener.open(request, timeout=30) as response:
                    data = response.read(100_000_001)
                    if not data or len(data) > 100_000_000:
                        raise ValueError('Unexpected empty or oversized upstream archive')
                    if hashlib.sha256(data).hexdigest() != expected_hash:
                        raise ValueError('Upstream download SHA-256 mismatch')
                    return data
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(1)
    with tempfile.TemporaryDirectory(prefix='relay-upstream-', dir=ROOT) as temporary:
        stage = Path(temporary)
        archive_data = fetch(f"https://codeload.github.com/{MANIFEST['repository']}/tar.gz/{MANIFEST['engine_ref']}", MANIFEST['engine_archive_sha256'])
        archive_hash = hashlib.sha256(archive_data).hexdigest()
        if archive_hash != MANIFEST['engine_archive_sha256']:
            raise ValueError('Original detector archive SHA-256 mismatch')
        with tarfile.open(fileobj=io.BytesIO(archive_data), mode='r:gz') as archive:
            for member in archive.getmembers():
                parts = Path(member.name).parts[1:]
                if not parts or not member.isfile() or any(p in ('.', '..') for p in parts):
                    continue
                if parts[0] not in ('gpt56_vnext', 'tests', 'LICENSE', 'THIRD_PARTY_NOTICES.md'):
                    continue
                output = stage.joinpath(*parts)
                if not output.resolve().is_relative_to(stage.resolve()):
                    raise ValueError('Unsafe upstream archive member')
                output.parent.mkdir(parents=True, exist_ok=True)
                stream = archive.extractfile(member)
                if stream is not None:
                    output.write_bytes(stream.read())
        (stage / 'benchmarks').mkdir()
        for item in [*MANIFEST['baselines'].values(), *MANIFEST.get('archived_baselines', {}).values()]:
            name = item['id'] + '--' + item['version'] + '.meow.json'
            # Content hash makes this immutable even if the upstream main branch advances.
            data = fetch(f"https://raw.githubusercontent.com/{MANIFEST['repository']}/{MANIFEST['baselines_ref']}/benchmarks/official/{name}", item['sha256'])
            (stage / 'benchmarks' / name).write_bytes(data)
        (stage / 'source-lock.json').write_text(json.dumps({'engine_ref': MANIFEST['engine_ref'], 'archive_sha256': archive_hash, 'baselines': MANIFEST['baselines']}, indent=2))
        verify(stage)
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(stage, destination)
    print('原 meow 4.5.4 已安装；基准 SHA-256 和档位请求数已校验。')
    return destination

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--proxy', help='Optional HTTP proxy, e.g. http://127.0.0.1:1082')
    args = parser.parse_args()
    try:
        bootstrap(args.proxy)
    except Exception as error:
        raise SystemExit('原检测器下载或校验失败：' + str(error)[:200] + '。请恢复 GitHub 网络后重试。')
