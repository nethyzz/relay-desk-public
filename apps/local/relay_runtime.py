"""WASM adaptation: preserve frozen detector, transport, parser and scoring code.

Only platform I/O changes: SQLite writes stay on the worker's single thread,
and httpx exchanges use the native app's bounded HTTPS transport.
"""
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

import httpx
from gpt56_vnext.benchmark import load_package
from gpt56_vnext.detector import DetectorSession
from gpt56_vnext.store import SQLiteStateStore
from gpt56_vnext.transport import AsyncTransport

sessions = {}
panel_db = sqlite3.connect(':memory:', isolation_level=None)
panel_db.row_factory = sqlite3.Row

def panel_restore(encoded):
    if encoded:
        panel_db.deserialize(base64.b64decode(encoded))
    panel_db.execute('PRAGMA foreign_keys=ON')

def panel_query(sql, params_json, kind):
    previous = panel_db.total_changes
    cursor = panel_db.execute(sql, json.loads(params_json))
    if kind == 'all':
        return json.dumps([dict(row) for row in cursor.fetchall()])
    changed = panel_db.execute('SELECT changes()').fetchone()[0] if panel_db.total_changes > previous else 0
    return json.dumps({'meta': {'changes': changed}, 'success': True})

def panel_verify(encoded):
    connection = sqlite3.connect(':memory:')
    try:
        connection.deserialize(base64.b64decode(encoded, validate=True))
        if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('备份数据库损坏')
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='endpoints'").fetchone():
            raise ValueError('备份不是 Relay Desk 数据库')
        return True
    finally:
        connection.close()

def panel_prepare_restore(encoded):
    panel_verify(encoded)
    connection = sqlite3.connect(':memory:')
    now = int(time.time() * 1000)
    try:
        connection.deserialize(base64.b64decode(encoded, validate=True))
        connection.execute("UPDATE runs SET attempts=CASE WHEN status='running' THEN reserved_attempts ELSE 0 END, status='cancelled',stop_requested_at=COALESCE(stop_requested_at,?),ended_at=?,key_cipher='',error='恢复备份时已停止任务；未确认请求按预留上限计入。',report=CASE WHEN report IS NOT NULL THEN json_set(report,'$.operational_status','paused') ELSE NULL END WHERE status IN ('queued','running')", (now, now))
        connection.execute("UPDATE batches SET used_minutes=CASE WHEN status='running' THEN reserved_minutes ELSE 0 END,status='completed',ended_at=?,lease_hash=NULL,lease_until=NULL WHERE status IN ('queued','dispatched','running')", (now,))
        connection.execute("UPDATE quota_reservations SET amount=(SELECT COALESCE(SUM(r.attempts),0) FROM runs r WHERE r.batch_id=substr(quota_reservations.id,1,length(quota_reservations.id)-9)) WHERE kind='requests'")
        connection.execute("UPDATE quota_reservations SET amount=COALESCE((SELECT b.used_minutes FROM batches b WHERE b.id=substr(quota_reservations.id,1,length(quota_reservations.id)-8)),amount) WHERE kind='minutes'")
        connection.execute("UPDATE notices SET status='cancelled' WHERE status IN ('pending','processing')")
        connection.execute('UPDATE schedules SET enabled=0,next_due=NULL')
        connection.execute('UPDATE run_sets SET ended_at=? WHERE ended_at IS NULL', (now,))
        connection.commit()
        return base64.b64encode(connection.serialize()).decode()
    finally:
        connection.close()

def panel_batch(items_json):
    panel_db.execute('BEGIN IMMEDIATE')
    try:
        result = [json.loads(panel_query(item['sql'], json.dumps(item['params']), 'run')) for item in json.loads(items_json)]
        panel_db.commit()
        return json.dumps(result)
    except BaseException:
        panel_db.rollback()
        raise

def panel_snapshot():
    return base64.b64encode(panel_db.serialize()).decode()

def panel_migrate(items_json):
    panel_db.execute('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)')
    for item in json.loads(items_json):
        if panel_db.execute('SELECT 1 FROM local_migrations WHERE name=?', (item['name'],)).fetchone():
            continue
        panel_db.executescript('BEGIN IMMEDIATE;\n' + item['sql'])
        panel_db.execute('INSERT INTO local_migrations VALUES (?)', (item['name'],))
        panel_db.commit()

class WorkerStateStore(SQLiteStateStore):
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._closed = False
        self.connection = sqlite3.connect(self.path, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self._initialize(self.connection)

    def _write(self, callback):
        if self._closed:
            raise RuntimeError('state store is closed')
        return callback(self.connection)

    def _read(self, callback):
        return callback(self.connection)

    def close(self):
        self.connection.close()
        self._closed = True

class NativeHTTPTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        import js
        request_id = uuid.uuid4().hex
        payload = {'id': request_id, 'url': str(request.url), 'method': request.method,
                   'headers': dict(request.headers), 'body': request.content.decode()}
        try:
            raw = await js.relay_http(json.dumps(payload))
            result = json.loads(raw)
            body = base64.b64decode(result['body_base64']) if 'body_base64' in result else result['body'].encode()
            return httpx.Response(result['status'], headers=result['headers'], content=body, request=request)
        except asyncio.CancelledError:
            js.relay_cancel(request_id)
            raise
        except Exception:
            raise httpx.ConnectError('本机无法连接模型服务', request=request) from None

class NativeTransport(AsyncTransport):
    def _client(self, base):
        if base not in self._clients:
            self._clients[base] = httpx.AsyncClient(transport=NativeHTTPTransport(), follow_redirects=False, timeout=self.timeout)
        return self._clients[base]

def relay_stop(ids_json):
    for run_id in json.loads(ids_json):
        if run_id in sessions:
            sessions[run_id].stop()

async def detect_one(job, workers, gates):
    import js
    config = job['config']
    name = config['baseline_id'] + '--' + config['baseline_version'] + '.meow.json'
    source = Path('/engine/benchmarks', name).read_bytes()
    if hashlib.sha256(source).hexdigest() != config['baseline_sha256']:
        raise ValueError('原检测器基准校验失败')
    package = load_package(source)
    path = Path('/tmp', 'relay-' + job['id'] + '.sqlite')
    store = WorkerStateStore(path)
    session = None
    updater = None
    running = None
    try:
        session = DetectorSession(store, job['id'], package, {
            'base_url': config['base_url'], 'request_model': config['request_model'],
            'claimed_model': config['claimed_model'], 'tier': config['tier'],
            'site_group': config['group_name'], 'benchmark_publisher': 'maintainer',
            'runtime': {'workers': workers, 'timeout': 120, 'retry_budget': config['retry_budget'], 'retain_raw': False},
        }, job['api_key'], transport=NativeTransport([job['api_key']], concurrency=workers, gates=gates))
        sessions[job['id']] = session
        async def progress():
            while True:
                await asyncio.sleep(5)
                await js.relay_progress(job['id'], json.dumps(session.report()))
        updater = asyncio.create_task(progress())
        running = asyncio.create_task(session.run())
        timed_out = False
        done, _ = await asyncio.wait({running}, timeout=600)
        if running not in done:
            timed_out = True
            session.stop()
            running.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await running
        report = session.report()
        attempts = int(report['progress'].get('http_attempts', job['maximum_attempts']))
        all_failed = report.get('results') and all(row['status'] == 'error' for row in report['results'])
        status = 'timed_out' if timed_out else 'failed' if report.get('failure') or all_failed else 'cancelled' if report['operational_status'] == 'paused' else 'completed'
        return {'status': status, 'report': report, 'attempts': min(job['maximum_attempts'], attempts),
                'error': '本地检测未完成，请查看报告' if status == 'failed' else None}
    finally:
        if running is not None and not running.done():
            session.stop()
            running.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await running
        if updater is not None:
            updater.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await updater
        sessions.pop(job['id'], None)
        store.close()
        for suffix in ['', '-wal', '-shm']:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(str(path) + suffix)

def local_notice_message(settings_json, notice_json):
    from relay_mail import notice_message
    from email.policy import SMTP
    return base64.b64encode(notice_message('https://local.invalid', json.loads(settings_json), json.loads(notice_json), local=True).as_bytes(policy=SMTP)).decode()

async def relay_detect_batch(jobs_json):
    import js
    jobs = json.loads(jobs_json)
    workers = max(1, min(8, 64 // max(1, len(jobs))))
    gates = {}
    async def run(job):
        try:
            result = await detect_one(job, workers, gates)
        except Exception:
            result = {'status': 'failed', 'attempts': job['maximum_attempts'], 'error': '本地检测初始化或执行失败', 'report': None}
        await js.relay_result(job['id'], json.dumps(result))
    await asyncio.gather(*(run(job) for job in jobs))
    return True
