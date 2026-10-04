"""Compare the adapter to the frozen original engine with synthetic, offline traces.

The fixtures exercise execution and scoring without consuming any provider API
quota. They are never inserted into the user's dashboard database.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.vendor'))
spec = importlib.util.spec_from_file_location('relay_parity_runner', ROOT / 'runner/execute.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
AVAILABLE = (ROOT / '.vendor/gpt56_vnext/detector.py').is_file()

class Trace:
    def __init__(self, package, limit=None):
        source = package['fitted']['sources'][0]
        self.answers = {identity: cell['categories'][max(range(len(cell['categories'])), key=lambda index: cell['alpha'][source][index])]
                        for identity, cell in package['fitted']['cells'].items()}
        self.limit, self.sent, self.closed = limit, 0, False
    async def request(self, mode, base, key, model, cell, *, on_dispatch=None, **kwargs):
        if self.limit is not None and self.sent >= self.limit:
            await asyncio.Future()
        on_dispatch()
        self.sent += 1
        await asyncio.sleep(0)
        return {'answer': self.answers[cell['id']], 'http_status': 200, 'usage': {'cost': 0.0}}
    async def close(self):
        self.closed = True

class Collector:
    def __init__(self): self.result = None
    async def post(self, path, payload):
        if '/results/' in path: self.result = payload
        return {'ok': True}

@unittest.skipUnless(AVAILABLE, 'Install the pinned original detector first')
class OriginalParityTests(unittest.IsolatedAsyncioTestCase):
    async def test_pause_interrupts_in_flight_requests_keeps_exact_counts_and_leaves_other_targets_running(self):
        from gpt56_vnext.benchmark import load_package
        baseline = json.loads((ROOT / 'runner/upstream.json').read_text())['baselines']['gpt']
        config = {'base_url': 'https://same.example.com/v1', 'request_model': 'fixture-alias', 'claimed_model': 'gpt-6.1-sol',
                  'tier': 'low', 'group_name': '离线停止验证', 'retry_budget': 16, 'baseline_id': baseline['id'],
                  'baseline_version': baseline['version'], 'baseline_sha256': baseline['sha256']}
        package = load_package(adapter.baseline_path(config).read_bytes())
        gate, waiting = asyncio.Event(), asyncio.Event()
        class InterruptTrace(Trace):
            def __init__(self, package):
                super().__init__(package)
                self.cancelled = 0
            async def request(self, mode, base, key, model, cell, *, on_dispatch=None, **kwargs):
                on_dispatch()
                self.sent += 1
                if self.sent > 3:
                    waiting.set()
                    try:
                        await asyncio.Future()
                    except asyncio.CancelledError:
                        self.cancelled += 1
                        raise
                await asyncio.sleep(0)
                return {'answer': self.answers[cell['id']], 'http_status': 200}
        class RemainingTrace(Trace):
            async def request(self, *args, **kwargs):
                await gate.wait()
                return await super().request(*args, **kwargs)
        stopped, remaining = InterruptTrace(package), RemainingTrace(package)
        first, second, stop = Collector(), Collector(), asyncio.Event()
        with patch.object(adapter, 'public_host'), patch('gpt56_vnext.executor.AsyncTransport', side_effect=lambda keys, **kwargs: stopped if keys == ['fixture-private-key'] else remaining):
            a = asyncio.create_task(adapter.execute_job(first, 'batch', {'id': 'first', 'config': config, 'api_key': 'fixture-private-key', 'maximum_attempts': 48}, time.monotonic() + 10, stop))
            b = asyncio.create_task(adapter.execute_job(second, 'batch', {'id': 'second', 'config': config, 'api_key': 'fixture-other-key', 'maximum_attempts': 48}, time.monotonic() + 10, asyncio.Event()))
            await asyncio.wait_for(waiting.wait(), 2)
            # Let the first three successful responses commit before pausing.
            await asyncio.sleep(.02)
            stop.set()
            await asyncio.wait_for(a, 2)
            sent_after_pause = stopped.sent
            self.assertFalse(b.done(), 'pausing one target must not cancel another')
            self.assertEqual(first.result['status'], 'cancelled')
            self.assertEqual(first.result['report']['fingerprint']['valid_samples'], 3)
            self.assertEqual(first.result['attempts'], sent_after_pause)
            self.assertEqual(first.result['report']['progress']['in_flight'], 0)
            self.assertEqual(first.result['report']['operational_status'], 'paused')
            self.assertGreater(stopped.cancelled, 0)
            self.assertTrue(stopped.closed)
            gate.set()
            await asyncio.wait_for(b, 2)
            self.assertEqual(second.result['status'], 'completed')
            self.assertEqual(second.result['attempts'], 32)
            self.assertEqual(stopped.sent, sent_after_pause, 'no new requests after pause acknowledgement')
            self.assertNotIn('fixture-private-key', json.dumps(first.result))

    async def test_preclaimed_stop_never_initializes_detector_or_provider_transport(self):
        collector, stop = Collector(), asyncio.Event()
        stop.set()
        with patch.object(adapter, 'public_host') as address, patch('gpt56_vnext.executor.AsyncTransport') as transport:
            await adapter.execute_job(collector, 'batch', {'id': 'run', 'config': {}, 'api_key': 'fixture-private-key', 'maximum_attempts': 48}, time.monotonic() + 10, stop)
        address.assert_not_called()
        transport.assert_not_called()
        self.assertEqual(collector.result, {'status': 'cancelled', 'attempts': 0, 'report': None})

    async def test_four_protocols_three_tiers_match_original_fingerprint(self):
        from gpt56_vnext.benchmark import load_package
        from gpt56_vnext.detector import DetectorSession
        from gpt56_vnext.store import SQLiteStateStore
        manifest = json.loads((ROOT / 'runner/upstream.json').read_text())
        for protocol, baseline in manifest['baselines'].items():
            for tier, count in baseline['counts'].items():
                with self.subTest(protocol=protocol, tier=tier):
                    config = {'base_url': 'https://api.example.com/v1', 'request_model': 'fixture-alias',
                              'tier': tier, 'group_name': '离线验证', 'retry_budget': (count + 1) // 2,
                              'baseline_id': baseline['id'], 'baseline_version': baseline['version'], 'baseline_sha256': baseline['sha256']}
                    package = load_package(adapter.baseline_path(config).read_bytes())
                    config['claimed_model'] = package['models'][0]['id']
                    with tempfile.TemporaryDirectory() as directory:
                        store = SQLiteStateStore(Path(directory) / 'original.sqlite3')
                        sender = Trace(package)
                        original = DetectorSession(store, 'reference', package, {**config, 'runtime': {'workers': 8, 'timeout': 120, 'retry_budget': config['retry_budget'], 'retain_raw': False}}, 'fixture-private-key', transport=sender)
                        try: expected = await original.run()
                        finally: store.close()
                    collector, trace = Collector(), Trace(package)
                    with patch.object(adapter, 'public_host'), patch('gpt56_vnext.executor.AsyncTransport', return_value=trace):
                        await adapter.execute_job(collector, 'test-batch', {'id': 'test-run', 'config': config, 'api_key': 'fixture-private-key', 'maximum_attempts': count + config['retry_budget']}, time.monotonic() + 30, request_workers=adapter.batch_request_workers(20))
                    self.assertEqual(collector.result['status'], 'completed')
                    self.assertEqual(collector.result['report']['fingerprint'], expected['fingerprint'])
                    self.assertEqual(collector.result['attempts'], count)
                    self.assertEqual(collector.result['report']['benchmark'], {**expected['benchmark'], 'publisher': 'maintainer'})
                    self.assertNotIn('fixture-private-key', json.dumps(collector.result))
                    self.assertTrue(trace.closed)

    async def test_old_frozen_gpt_baselines_remain_available_and_match_original(self):
        from gpt56_vnext.benchmark import load_package
        from gpt56_vnext.detector import DetectorSession
        from gpt56_vnext.store import SQLiteStateStore
        manifest = json.loads((ROOT / 'runner/upstream.json').read_text())
        for baseline in manifest['archived_baselines'].values():
            config = {'base_url': 'https://api.example.com/v1', 'request_model': 'fixture-alias', 'claimed_model': 'gpt-6-sol', 'tier': 'low', 'group_name': '旧配置', 'retry_budget': 16, 'baseline_id': baseline['id'], 'baseline_version': baseline['version'], 'baseline_sha256': baseline['sha256']}
            package = load_package(adapter.baseline_path(config).read_bytes())
            with tempfile.TemporaryDirectory() as directory:
                store = SQLiteStateStore(Path(directory) / 'reference.sqlite')
                original = DetectorSession(store, 'reference', package, {**config, 'runtime': {'workers': 8, 'timeout': 120, 'retry_budget': 16}}, 'fixture-key', transport=Trace(package))
                try: expected = await original.run()
                finally: store.close()
            collector = Collector()
            with patch.object(adapter, 'public_host'), patch('gpt56_vnext.executor.AsyncTransport', return_value=Trace(package)):
                await adapter.execute_job(collector, 'batch', {'id': 'run', 'config': config, 'api_key': 'fixture-key', 'maximum_attempts': 48}, time.monotonic() + 30)
            self.assertEqual(collector.result['report']['fingerprint'], expected['fingerprint'])

    async def test_twenty_real_detector_sessions_run_concurrently_with_bounded_requests_and_separate_evidence(self):
        from gpt56_vnext.benchmark import load_package
        baseline = json.loads((ROOT / 'runner/upstream.json').read_text())['baselines']['gpt']
        config = {'base_url': 'https://same.example.com/v1', 'request_model': 'fixture-alias', 'claimed_model': 'gpt-6.1-sol', 'tier': 'low', 'group_name': '并发验证', 'retry_budget': 16, 'baseline_id': baseline['id'], 'baseline_version': baseline['version'], 'baseline_sha256': baseline['sha256']}
        package = load_package(adapter.baseline_path(config).read_bytes())
        count = 20
        workers = adapter.batch_request_workers(count)
        gate, entered, active, peak = asyncio.Event(), set(), 0, 0
        class ConcurrentTrace(Trace):
            async def request(self, *args, **kwargs):
                nonlocal active, peak
                entered.add(id(self))
                active += 1
                peak = max(peak, active)
                if len(entered) == count: gate.set()
                try:
                    await gate.wait()
                    return await super().request(*args, **kwargs)
                finally:
                    active -= 1
        traces = [ConcurrentTrace(package) for _ in range(count)]
        collectors = [Collector() for _ in traces]
        with patch.object(adapter, 'public_host'), patch('gpt56_vnext.executor.AsyncTransport', side_effect=traces):
            await asyncio.wait_for(asyncio.gather(*(adapter.execute_job(collectors[i], 'batch', {'id': f'run-{i}', 'config': config, 'api_key': f'fixture-key-{i}', 'maximum_attempts': 48}, time.monotonic() + 20, request_workers=workers) for i in range(count))), 20)
        self.assertEqual(len(entered), count)
        self.assertGreaterEqual(peak, count)
        self.assertLessEqual(peak, adapter.MAX_BATCH_REQUESTS)
        self.assertEqual(active, 0)
        fingerprint = collectors[0].result['report']['fingerprint']
        for collector, trace in zip(collectors, traces):
            self.assertEqual(collector.result['status'], 'completed')
            self.assertEqual(collector.result['attempts'], 32)
            self.assertEqual(collector.result['report']['fingerprint']['valid_samples'], 32)
            self.assertEqual(collector.result['report']['fingerprint'], fingerprint)
            self.assertTrue(trace.closed)

    async def test_timeout_preserves_actual_partial_evidence(self):
        from gpt56_vnext.benchmark import load_package
        baseline = json.loads((ROOT / 'runner/upstream.json').read_text())['baselines']['gpt']
        config = {'base_url': 'https://api.example.com/v1', 'request_model': 'fixture-alias',
                  'tier': 'low', 'group_name': '离线验证', 'retry_budget': 16, 'baseline_id': baseline['id'], 'baseline_version': baseline['version'], 'baseline_sha256': baseline['sha256']}
        package = load_package(adapter.baseline_path(config).read_bytes())
        config['claimed_model'] = package['models'][0]['id']
        trace, collector = Trace(package, 7), Collector()
        with patch.object(adapter, 'public_host'), patch('gpt56_vnext.executor.AsyncTransport', return_value=trace):
            await adapter.execute_job(collector, 'batch', {'id': 'run', 'config': config, 'api_key': 'fixture-private-key', 'maximum_attempts': 48}, time.monotonic() + 1)
        self.assertEqual(collector.result['status'], 'timed_out')
        self.assertEqual(collector.result['report']['fingerprint']['verdict'], 'insufficient')
        self.assertEqual(collector.result['report']['fingerprint']['valid_samples'], 7)
        self.assertEqual(collector.result['attempts'], 7)
        self.assertTrue(trace.closed)

if __name__ == '__main__': unittest.main()
