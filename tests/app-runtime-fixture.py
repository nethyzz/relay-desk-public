"""The same offline trace runs in CPython and the bundled WASM Python."""
import asyncio
import base64
import contextlib
import json
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] if '__file__' in globals() else Path('/engine')
if sys.platform != 'emscripten':
    sys.path.insert(0, str(ROOT / '.vendor'))
    sys.path.insert(0, str(ROOT / 'apps/local'))

from gpt56_vnext.benchmark import load_package
from gpt56_vnext.detector import DetectorSession
from gpt56_vnext.store import SQLiteStateStore
import httpx
from relay_runtime import NativeTransport, WorkerStateStore
from gpt56_vnext.transport import AsyncTransport

class OfflineTrace:
    def __init__(self, package):
        source = package['fitted']['sources'][0]
        self.answers = {identity: cell['categories'][max(range(len(cell['categories'])), key=lambda i: cell['alpha'][source][i])]
                        for identity, cell in package['fitted']['cells'].items()}
    async def request(self, mode, base, key, model, cell, *, on_dispatch=None, **kwargs):
        on_dispatch()
        await asyncio.sleep(0)
        return {'answer': self.answers[cell['id']], 'http_status': 200, 'usage': {'cost': 0}}
    async def close(self):
        pass

async def app_fixture():
    results = []
    baseline_dir = Path('/engine/benchmarks') if sys.platform == 'emscripten' else ROOT / '.vendor/benchmarks'
    for path in sorted(baseline_dir.glob('*.meow.json')):
        package = load_package(path.read_bytes())
        for tier in ['low', 'medium', 'high']:
            with tempfile.TemporaryDirectory() as directory:
                store_type = WorkerStateStore if sys.platform == 'emscripten' else SQLiteStateStore
                store = store_type(Path(directory) / 'state.sqlite')
                session = DetectorSession(store, 'offline-fixture', package, {
                    'base_url': 'https://fixture.example.com/v1', 'request_model': 'fixture-alias',
                    'claimed_model': package['models'][0]['id'], 'tier': tier,
                    'runtime': {'workers': 8, 'retry_budget': 0},
                }, 'offline-fixture-private-key', transport=OfflineTrace(package))
                report = await session.run()
                progress = report['progress']
                results.append({'baseline': path.name, 'tier': tier, 'fingerprint': report['fingerprint'],
                                'progress': {key: progress[key] for key in ['status', 'planned', 'http_attempts', 'logical_completed', 'valid_samples', 'retries']}})
                store.close()
    transport_results = await transport_fixture()
    return json.dumps({'detectors': results, 'transports': transport_results})

async def transport_fixture():
    """Compare native bridge payloads and stream parsing to the original HTTP client."""
    results = []
    key = 'offline-fixture-private-key'
    previous_js = sys.modules.get('js')
    frames = {
        'gpt': [{'type': 'response.completed', 'response': {'id': 'fixture', 'status': 'completed', 'output': [{'content': [{'type': 'output_text', 'text': '47'}]}]}}],
        'chat': [{'choices': [{'index': 0, 'delta': {'content': '47'}, 'finish_reason': 'stop'}]}],
        'claude': [{'type': 'message_start', 'message': {'usage': {}}}, {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': '47'}}, {'type': 'content_block_stop', 'index': 0}, {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 1}}, {'type': 'message_stop'}],
    }
    try:
        for mode, events in frames.items():
            captured = []
            body = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + ('data: [DONE]\n\n' if mode == 'chat' else '')
            headers = {'content-type': 'text/event-stream'}
            async def bridge(raw):
                captured.append(json.loads(raw))
                return json.dumps({'status': 200, 'headers': headers, 'body_base64': base64.b64encode(body.encode()).decode()})
            sys.modules['js'] = types.SimpleNamespace(relay_http=bridge, relay_cancel=lambda _: None)
            original = AsyncTransport([key]); native = NativeTransport([key])
            base = 'https://fixture.example.com/v1'
            original._clients[base] = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, headers=headers, text=body)))
            cell = {'id': 'fixture-cell', 'prompt': 'Reply with the number 47.', 'effort': 'low'}
            dispatched = [0, 0]
            try:
                expected = await original.request(mode, base, key, 'fixture-model', cell, on_dispatch=lambda: dispatched.__setitem__(0, dispatched[0] + 1))
                actual = await native.request(mode, base, key, 'fixture-model', cell, on_dispatch=lambda: dispatched.__setitem__(1, dispatched[1] + 1))
                for result in [expected, actual]: result.pop('elapsed_ms', None)
                assert expected == actual
                assert dispatched == [1, 1]
                assert captured[0]['headers']['authorization'] == 'Bearer ' + key
                assert json.loads(captured[0]['body']) == expected['request_json']
                results.append({'mode': mode, 'answer': actual['answer'], 'http_status': actual['http_status'], 'dispatches': dispatched})
            finally:
                await original.close(); await native.close()
                assert native.guard._values == ()
        entered = asyncio.Event(); cancelled = []
        async def waiting(raw):
            entered.set(); await asyncio.Future()
        sys.modules['js'] = types.SimpleNamespace(relay_http=waiting, relay_cancel=lambda request_id: cancelled.append(request_id))
        native = NativeTransport([key])
        task = asyncio.create_task(native.request('chat', base, key, 'fixture-model', cell))
        await entered.wait(); task.cancel()
        with contextlib.suppress(asyncio.CancelledError): await task
        await native.close()
        assert len(cancelled) == 1
        results.append({'mode': 'cancel', 'cancelled_requests': len(cancelled)})
        return results
    finally:
        if previous_js is None: sys.modules.pop('js', None)
        else: sys.modules['js'] = previous_js

if __name__ == "__main__":
    print(asyncio.run(app_fixture()))
