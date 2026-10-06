"""Persistence and recovery checks for the native worker's SQLite adapter."""
import base64
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.vendor'))
sys.path.insert(0, str(ROOT / 'apps/local'))
import relay_runtime as runtime

class RuntimeCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_initialization_failure_closes_store_and_removes_temporary_database(self):
        cache = ROOT / '.app-build/native-python-tests'
        cache.mkdir(parents=True, exist_ok=True)
        benchmark = next((ROOT / '.vendor/benchmarks').glob('*.meow.json'))
        identifier, version = benchmark.name.removesuffix('.meow.json').split('--')
        stores = []
        original_store = runtime.WorkerStateStore
        def tracked_store(path):
            store = original_store(path)
            stores.append(store)
            return store
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            def local_path(first, *parts):
                if first == '/engine/benchmarks': return benchmark
                if first == '/tmp': return Path(temporary, *parts)
                return Path(first, *parts)
            config = {'baseline_id': identifier, 'baseline_version': version,
                      'baseline_sha256': hashlib.sha256(benchmark.read_bytes()).hexdigest(),
                      'base_url': 'https://example.com', 'request_model': 'fixture',
                      'claimed_model': 'fixture', 'tier': 'quick', 'group_name': 'fixture', 'retry_budget': 0}
            with patch.dict(sys.modules, {'js': types.SimpleNamespace()}), \
                 patch.object(runtime, 'Path', local_path), \
                 patch.object(runtime, 'load_package', return_value=object()), \
                 patch.object(runtime, 'WorkerStateStore', side_effect=tracked_store), \
                 patch.object(runtime, 'DetectorSession', side_effect=RuntimeError('fixture initialization failed')):
                with self.assertRaises(RuntimeError):
                    await runtime.detect_one({'id': 'cleanup-fixture', 'config': config, 'api_key': 'fixture'}, 1, {})
            self.assertTrue(stores[0]._closed)
            self.assertFalse(list(Path(temporary).glob('relay-*')))

class LocalRuntimeTests(unittest.TestCase):
    def setUp(self):
        runtime.panel_db.close()
        runtime.panel_db = sqlite3.connect(':memory:', isolation_level=None)
        runtime.panel_db.row_factory = sqlite3.Row
        runtime.panel_restore('')
        migrations = [{'name': path.name, 'sql': path.read_text()} for path in sorted((ROOT / 'migrations').glob('*.sql'))]
        runtime.panel_migrate(json.dumps(migrations))

    def test_with_update_reports_direct_changes_without_counting_trigger_writes(self):
        db = runtime.panel_db
        db.executescript("CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(1); CREATE TABLE audit(value INTEGER); CREATE TRIGGER fixture_audit AFTER UPDATE ON fixture BEGIN INSERT INTO audit VALUES(NEW.value); END;")
        result = json.loads(runtime.panel_query('WITH v AS (SELECT 2 AS value) UPDATE fixture SET value=(SELECT value FROM v)', '[]', 'run'))
        self.assertEqual(result['meta']['changes'], 1)
        self.assertEqual(db.execute('SELECT count(*) FROM audit').fetchone()[0], 1)

    def test_batch_rolls_back_all_changes_after_a_constraint_error(self):
        with self.assertRaises(sqlite3.IntegrityError):
            runtime.panel_batch(json.dumps([{'sql': "INSERT INTO groups VALUES('new','新增',1)", 'params': []}, {'sql': "INSERT INTO groups VALUES('default','冲突',1)", 'params': []}]))
        self.assertIsNone(runtime.panel_db.execute("SELECT id FROM groups WHERE id='new'").fetchone())

    def test_snapshot_keeps_foreign_keys_and_full_reports(self):
        db = runtime.panel_db
        db.execute("INSERT INTO groups VALUES('saved','已保存的分组',1)")
        snapshot = runtime.panel_snapshot()
        self.assertTrue(runtime.panel_verify(snapshot))
        db.execute("DELETE FROM groups WHERE id='saved'")
        runtime.panel_restore(snapshot)
        self.assertEqual(db.execute("SELECT name FROM groups WHERE id='saved'").fetchone()[0], '已保存的分组')
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO targets(id,endpoint_id,name,protocol,request_model,claimed_model,created_at) VALUES('t','missing','t','openai','gpt','gpt',1)")

    def test_restore_preserves_configuration_but_disables_automatic_work(self):
        db = runtime.panel_db
        db.execute("INSERT INTO endpoints(id,group_id,name,base_url,key_cipher,created_at,updated_at) VALUES('e','default','stored','https://example.com','cipher',1,1)")
        db.execute("INSERT INTO targets(id,endpoint_id,name,protocol,request_model,claimed_model,created_at) VALUES('t','e','saved','openai','model','model',1)")
        db.execute("INSERT INTO schedules(target_id,enabled,updated_at) VALUES('t',1,1)")
        db.execute("INSERT INTO batches(id,status,created_at) VALUES('b','running',1)")
        db.execute("INSERT INTO runs(id,batch_id,target_id,status,source,created_at,snapshot,key_cipher,reserved_attempts,quota_day) VALUES('r','b','t','running','manual',1,'{}','cipher',20,'day')")
        db.execute("INSERT INTO quota_reservations VALUES('b:requests','requests','day',20)")
        db.execute("INSERT INTO quota_reservations VALUES('b:minutes','minutes','month',15)")
        db.execute("INSERT INTO notices(id,kind,reference,created_at) VALUES('n','run','r',1)")
        prepared = runtime.panel_prepare_restore(runtime.panel_snapshot())
        # Preparing a restore must not mutate the currently open database.
        self.assertEqual(db.execute("SELECT status FROM runs").fetchone()[0], 'running')
        runtime.panel_restore(prepared)
        self.assertEqual(db.execute('SELECT key_cipher FROM endpoints').fetchone()[0], 'cipher')
        self.assertEqual(tuple(db.execute('SELECT status,attempts,key_cipher FROM runs').fetchone()), ('cancelled', 20, ''))
        self.assertEqual(db.execute('SELECT enabled FROM schedules').fetchone()[0], 0)
        self.assertEqual(db.execute('SELECT status FROM notices').fetchone()[0], 'cancelled')
        self.assertEqual(db.execute("SELECT amount FROM quota_reservations WHERE kind='requests'").fetchone()[0], 20)

    def test_rejects_corrupt_and_unrelated_sqlite_backups(self):
        with self.assertRaises(Exception): runtime.panel_verify(base64.b64encode(b'not sqlite').decode())
        other = sqlite3.connect(':memory:'); other.execute('CREATE TABLE other(id INTEGER)')
        with self.assertRaises(ValueError): runtime.panel_verify(base64.b64encode(other.serialize()).decode())
        other.close()

if __name__ == '__main__': unittest.main()
