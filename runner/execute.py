"""Private cloud/local execution adapter. Credentials never become CLI arguments."""
from __future__ import annotations
import argparse
import asyncio
import contextlib
import ipaddress
import json
import math
import os
from pathlib import Path
import smtplib
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
STOP_POLL_SECONDS = 3
MAX_BATCH_REQUESTS = 64
sys.path.insert(0, str(ROOT)) if str(ROOT) not in sys.path else None
from runner.network import public_address, proxy_dns_addresses
from runner.mail import notice_message

class ExecutionError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)

def public_dns_addresses(hostname: str) -> list:
    addresses = []
    for record_type in (1, 28):
        url = 'https://cloudflare-dns.com/dns-query?' + urllib.parse.urlencode({'name': hostname, 'type': record_type})
        request = urllib.request.Request(url, headers={'Accept': 'application/dns-json'})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                data = json.loads(response.read(65536))
            if data.get('Status') != 0:
                raise ExecutionError('dns_error')
            addresses.extend(ipaddress.ip_address(answer['data']) for answer in data.get('Answer', []) if answer.get('type') in (1, 28))
        except ExecutionError:
            raise
        except Exception:
            raise ExecutionError('public_dns_unavailable') from None
    return addresses

def public_host(url: str, *, local: bool = False) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ExecutionError('unsafe_destination')
    if '.' not in parsed.hostname or parsed.hostname.endswith(('.local', '.internal', '.localhost')):
        raise ExecutionError('unsafe_destination')
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        pass
    else:
        raise ExecutionError('unsafe_destination')
    try:
        addresses = [ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)]
    except socket.gaierror:
        raise ExecutionError('dns_error') from None
    if addresses and all(public_address(address) for address in addresses):
        return
    if proxy_dns_addresses(addresses):
        # Local fake DNS needs a working HTTP proxy or a verified TUN route,
        # plus a separate public DNS check. Cloud execution stays strict.
        proxy = None
        if local:
            from gpt56_vnext.proxies import resolve_proxy
            proxy = resolve_proxy(url).proxy_url
        if local and (proxy or os.environ.get('RELAY_LOCAL_NETWORK_MODE') == 'tun'):
            public_addresses = public_dns_addresses(parsed.hostname)
            if public_addresses and all(public_address(address) for address in public_addresses):
                return
            raise ExecutionError('unsafe_destination')
        raise ExecutionError('proxy_dns_unavailable' if local else 'unsafe_destination')
    raise ExecutionError('unsafe_destination')

def execution_diagnostic(error: Exception, stage: str) -> dict:
    # Only controlled text is retained here. API exceptions can echo credentials.
    code = error.code if isinstance(error, ExecutionError) else (
        'dns_error' if isinstance(error, socket.gaierror) else
        'tls_error' if isinstance(error, ssl.SSLError) else
        'detector_unavailable' if isinstance(error, (ModuleNotFoundError, FileNotFoundError)) else
        'request_timeout' if isinstance(error, TimeoutError) else 'runner_error')
    messages = {
        'unsafe_destination': 'API 地址未通过公网地址检查。',
        'proxy_dns_unavailable': '本地代理使用虚拟 DNS，但检测器没有可用的 HTTP 代理。',
        'public_dns_unavailable': '通过本地代理验证公网 DNS 失败。',
        'dns_error': '无法解析 API 域名。',
        'tls_error': 'HTTPS 证书或 TLS 握手失败。',
        'detector_unavailable': '检测器依赖或固定基准文件不可用。',
        'benchmark_error': '固定基准文件的校验值不一致。',
        'request_timeout': '请求超过等待时间。',
        'runner_error': '检测执行器在完成前发生错误。',
    }
    return {'code': code, 'stage': stage, 'message': messages.get(code, messages['runner_error'])}

def mask_secret(secret: str) -> None:
    if os.environ.get('GITHUB_ACTIONS') == 'true' and secret:
        # This is GitHub's masking control command, not a normal log message.
        print('::add-mask::' + secret.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)

def cloud_failure_message(error: Exception, stage: str) -> str:
    # Infrastructure exceptions can contain bearer tokens or response bodies.
    # Keep only our stage label, exception category and numeric HTTP status.
    label = {'identity': '获取 GitHub 身份凭证', 'execution': '领取任务与回传报告'}.get(stage, '初始化执行器')
    if isinstance(error, urllib.error.HTTPError):
        reason = f'HTTP {error.code}' if isinstance(error.code, int) and 100 <= error.code <= 599 else 'HTTP 请求失败'
    elif isinstance(error, urllib.error.URLError):
        reason = '网络连接失败'
    elif isinstance(error, TimeoutError):
        reason = '连接超时'
    elif isinstance(error, KeyError):
        reason = '执行器配置不完整'
    elif isinstance(error, json.JSONDecodeError):
        reason = '服务没有返回有效 JSON'
    else:
        reason = '执行器内部错误'
    return f'检测执行器未完成（{label}：{reason}）。请在私人面板检查任务状态。凭据和上游原始错误不会写入日志。'

class Client:
    def __init__(self, origin: str, lease: str = '', local_headers: dict | None = None):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != 'https' and not (local_headers and parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'):
            raise ValueError('Panel origin must be HTTPS')
        self.origin = origin.rstrip('/')
        self.lease = lease
        self.local_headers = local_headers or {}
        self.opener = urllib.request.build_opener()
    def request(self, path: str, payload: dict | None = None, oidc: str | None = None):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Relay-Desk/1.0', **self.local_headers}
        if oidc or self.lease:
            headers['Authorization'] = 'Bearer ' + (oidc or self.lease)
        request = urllib.request.Request(self.origin + '/api/' + path, headers=headers, data=json.dumps(payload).encode() if payload is not None else None)
        with self.opener.open(request, timeout=30) as response:
            return json.loads(response.read())
    async def post(self, path: str, payload: dict):
        for attempt in range(3):
            try:
                return await asyncio.to_thread(self.request, path, payload)
            except urllib.error.HTTPError as error:
                if error.code < 500:
                    raise
            except (OSError, ValueError):
                pass
            if attempt < 2:
                await asyncio.sleep(1 + attempt)
        raise RuntimeError('Could not save execution results to the private panel')

def oidc_token(origin: str) -> str:
    url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']
    url += ('&' if '?' in url else '?') + urllib.parse.urlencode({'audience': origin})
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'], 'Accept': 'application/json', 'User-Agent': 'Relay-Desk/1.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        token = json.loads(response.read())['value']
    mask_secret(token)
    return token

def attempts_in(report: dict, maximum: int) -> int:
    progress = report.get('progress', {})
    for key in ('actual_attempts', 'http_attempts', 'attempts', 'total_attempts', 'attempt_count'):
        value = progress.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum:
            return value
    events = report.get('events', [])
    starts = [e for e in events if isinstance(e, dict) and e.get('type', e.get('event', e.get('kind'))) in ('attempt_start', 'attempt_started')]
    if starts:
        return min(len(starts), maximum)
    # Unknown upstream accounting is conservatively charged at the reserved maximum.
    return maximum

def baseline_path(config: dict) -> Path:
    path = ROOT / '.vendor/benchmarks' / (config['baseline_id'] + '--' + config['baseline_version'] + '.meow.json')
    import hashlib
    if hashlib.sha256(path.read_bytes()).hexdigest() != config['baseline_sha256']:
        raise ExecutionError('benchmark_error')
    return path

def batch_request_workers(job_count: int) -> int:
    # Network waits dominate detection. Keep the frozen engine's eight workers
    # for small batches, then divide one runner's request budget across targets.
    return max(1, min(8, MAX_BATCH_REQUESTS // max(1, job_count)))

async def execute_job(client: Client, batch_id: str, job: dict, deadline: float, stop_event: asyncio.Event | None = None, *, request_workers: int = 8, rate_gates: dict | None = None):
    session = None
    store = None
    progress_task = None
    stop_task = None
    running = None
    report = None
    status = 'failed'
    attempts = 0
    stage = 'address_check'
    key = job['api_key']
    mask_secret(key)
    prefix = f'runner/batches/{batch_id}/'
    with tempfile.TemporaryDirectory(prefix='relay-detector-') as directory:
        try:
            remaining = deadline - time.monotonic()
            if stop_event is not None and stop_event.is_set():
                status = 'cancelled'
            elif remaining <= 0:
                status = 'timed_out'
            else:
                sys.path.insert(0, str(ROOT / '.vendor')) if str(ROOT / '.vendor') not in sys.path else None
                await asyncio.to_thread(public_host, job['config']['base_url'], local=bool(getattr(client, 'local_headers', None)))
                if stop_event is not None and stop_event.is_set():
                    status = 'cancelled'
                    return
                stage = 'detector_setup'
                from gpt56_vnext.detector import DetectorSession
                from gpt56_vnext.executor import AsyncTransport
                from gpt56_vnext.store import SQLiteStateStore
                from gpt56_vnext.benchmark import load_package
                config = job['config']
                package = load_package(baseline_path(config).read_bytes())
                store = SQLiteStateStore(Path(directory) / 'state.sqlite3')
                options = {'base_url': config['base_url'], 'allow_insecure': False, 'request_model': config['request_model'], 'claimed_model': config['claimed_model'], 'tier': config['tier'], 'site_group': config['group_name'], 'benchmark_publisher': 'maintainer', 'runtime': {'workers': request_workers, 'timeout': 120, 'retry_budget': config['retry_budget'], 'retain_raw': False}}
                transport = AsyncTransport([key], timeout=120, concurrency=request_workers, gates=rate_gates)
                session = DetectorSession(store, job['id'], package, options, key, transport=transport)
                stage = 'detection'
                async def progress():
                    while True:
                        await asyncio.sleep(10)
                        with contextlib.suppress(Exception):
                            control = await client.post(prefix + 'progress', {'run_id': job['id'], 'report': session.report()})
                            if control.get('stop_requested') and stop_event is not None:
                                stop_event.set()
                progress_task = asyncio.create_task(progress())
                running = asyncio.create_task(session.run())
                stop_task = asyncio.create_task(stop_event.wait()) if stop_event is not None else None
                try:
                    watched = {running, stop_task} if stop_task is not None else {running}
                    done, _ = await asyncio.wait(watched, timeout=max(0, deadline - time.monotonic()), return_when=asyncio.FIRST_COMPLETED)
                    stopped = stop_event is not None and stop_event.is_set()
                    if stopped or running not in done:
                        # Use the upstream stop mechanism to cancel transports,
                        # settle dispatched attempts and retain completed samples.
                        session.stop()
                        running.cancel()
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await running
                        report = session.report()
                        status = 'cancelled' if stopped else 'timed_out'
                    else:
                        report = await running
                        failed_samples = report.get('results', [])
                        all_failed = failed_samples and all(row.get('status') == 'error' for row in failed_samples)
                        status = 'failed' if report.get('failure') or all_failed else 'completed'
                finally:
                    if stop_task is not None:
                        stop_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await stop_task
                attempts = attempts_in(report, job['maximum_attempts'])
        except Exception as error:
            if session is not None:
                session.stop()
                with contextlib.suppress(Exception):
                    report = session.report()
                    attempts = attempts_in(report, job['maximum_attempts'])
            diagnostic = execution_diagnostic(error, stage)
            report = report or {'progress': {'http_attempts': attempts}, 'results': []}
            report.setdefault('diagnostics', []).append(diagnostic)
            report['failure'] = report.get('failure') or diagnostic['code']
            # Do not print exceptions from API clients: providers may echo credentials.
            print('一个检测目标未完成；结果与可用证据将回传面板。', flush=True)
        finally:
            # Never close the store while upstream request workers still use it.
            if running is not None and not running.done():
                session.stop()
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await running
            if progress_task is not None:
                progress_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await progress_task
            if store is not None:
                store.close()
            await client.post(prefix + 'results/' + job['id'], {'status': status, 'attempts': attempts, 'report': report})

def send_notice(origin: str, settings: dict, notice: dict) -> None:
    if not settings or not settings.get('enabled'):
        return
    public_host('https://' + settings['host'])
    password = settings['password']
    mask_secret(password)
    message = notice_message(origin, settings, notice)
    context = ssl.create_default_context()
    phase = 'connect'
    smtp = None
    try:
        smtp = smtplib.SMTP_SSL(settings['host'], 465, timeout=30, context=context) if settings['port'] == 465 else smtplib.SMTP(settings['host'], settings['port'], timeout=30)
        if settings['port'] != 465:
            phase = 'tls'
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        phase = 'greeting'
        smtp.ehlo_or_helo_if_needed()
        phase = 'authentication'
        if settings['host'].lower() == 'smtp.qq.com' and 'LOGIN' in smtp.esmtp_features.get('auth', '').upper().split():
            # QQ advertises LOGIN and PLAIN, but may close the connection for
            # an inline PLAIN response. Use its advertised challenge flow.
            smtp.user, smtp.password = settings['username'], password
            smtp.auth('LOGIN', smtp.auth_login, initial_response_ok=False)
        else:
            smtp.login(settings['username'], password)
        phase = 'delivery'
        refused = smtp.send_message(message)
        if refused: raise smtplib.SMTPRecipientsRefused(refused)
    except Exception as error:
        error.relay_smtp_phase = phase
        raise
    finally:
        # DATA acknowledgement determines delivery. A broken QUIT response must
        # not turn an accepted email into a failure or cause a duplicate send.
        if smtp:
            with contextlib.suppress(smtplib.SMTPException, OSError): smtp.quit()
            with contextlib.suppress(OSError): smtp.close()

async def deliver_notices(client: Client, batch_id: str, mail: dict | None, notices: list[dict]):
    if not mail or not mail.get('enabled'):
        return
    for notice in notices:
        begin = await client.post(f'runner/batches/{batch_id}/notice-begin', {'notice_id': notice['id']})
        if not begin.get('send'):
            continue
        ok = False
        error_code = None
        try:
            await asyncio.to_thread(send_notice, client.origin, mail, notice)
            ok = True
        except Exception as error:
            # Return only a fixed category; SMTP responses may echo passwords or addresses.
            if isinstance(error, smtplib.SMTPAuthenticationError): error_code = 'smtp_protocol' if error.smtp_code in (502, 504) else 'smtp_auth'
            elif isinstance(error, smtplib.SMTPRecipientsRefused): error_code = 'smtp_recipient'
            elif isinstance(error, smtplib.SMTPSenderRefused): error_code = 'smtp_sender'
            elif isinstance(error, ssl.SSLError): error_code = 'smtp_tls'
            elif isinstance(error, smtplib.SMTPResponseException) and 400 <= error.smtp_code < 500: error_code = 'smtp_busy'
            elif isinstance(error, (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected)): error_code = 'smtp_connect'
            elif isinstance(error, smtplib.SMTPResponseException) and 500 <= error.smtp_code < 600: error_code = 'smtp_rejected'
            elif isinstance(error, smtplib.SMTPException): error_code = 'smtp_protocol'
            elif isinstance(error, OSError): error_code = 'smtp_connect'
            smtp_status = getattr(error, 'smtp_code', None)
            safe_status = smtp_status if isinstance(smtp_status, int) and -1 <= smtp_status <= 599 else 'unknown'
            phase = getattr(error, 'relay_smtp_phase', 'unknown')
            safe_phase = phase if phase in ('connect', 'tls', 'greeting', 'authentication', 'delivery') else 'unknown'
            print(f'邮件未发送成功（{type(error).__name__}，SMTP {safe_status}，phase={safe_phase}）；检测报告仍可在面板中查看。', flush=True)
        await client.post(f'runner/batches/{batch_id}/notice-result', {'notice_id': notice['id'], 'ok': ok, 'error_code': error_code, 'phase': safe_phase if not ok else None})

async def run_batch(client: Client, batch_id: str, oidc: str | None, workflow_started: float):
    # Claim is deliberately not retried: a lost response must never cause duplicate API tests.
    claim = await asyncio.to_thread(client.request, f'runner/batches/{batch_id}/claim', {}, oidc)
    if claim.get('done'):
        return
    client.lease = claim['lease']
    mask_secret(client.lease)
    stop_events = {job['id']: asyncio.Event() for job in claim.get('jobs', [])}
    for job in claim.get('jobs', []):
        if job.get('stop_requested'):
            stop_events[job['id']].set()
    async def controls():
        response = await client.post(f'runner/batches/{batch_id}/heartbeat', {})
        for run_id in response.get('stop_run_ids', []):
            if run_id in stop_events:
                stop_events[run_id].set()
    async def heartbeat():
        while True:
            await asyncio.sleep(STOP_POLL_SECONDS if claim['kind'] == 'detection' else 25)
            with contextlib.suppress(Exception):
                await controls()
    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        if claim['kind'] == 'detection':
            # Check once before opening any provider connections; a stop may
            # have arrived immediately after claim returned its credentials.
            await controls()
            deadline = time.monotonic() + min(600, claim.get('timeout_seconds', 600))
            # Bounded batches share one runner and the original upstream rate
            # gates. A 429/Retry-After slows the same station's other models too.
            # Sampling, retry budgets and scoring stay in the frozen engine.
            workers = batch_request_workers(len(claim['jobs']))
            rate_gates = {}
            jobs = [execute_job(client, batch_id, job, deadline, stop_events[job['id']], request_workers=workers, rate_gates=rate_gates) for job in claim['jobs']]
            # A failed result submission must not cancel another target's
            # detection or discard its evidence. Wait for every submission,
            # then report only a fixed error without provider response text.
            outcomes = await asyncio.gather(*jobs, return_exceptions=True)
            if any(isinstance(outcome, BaseException) for outcome in outcomes):
                raise RuntimeError('部分检测结果回传失败；其余已提交报告仍保存在面板。') from None
            notifications = await client.post(f'runner/batches/{batch_id}/notices', {})
            await deliver_notices(client, batch_id, notifications.get('mail'), notifications.get('notices', []))
        else:
            await deliver_notices(client, batch_id, claim.get('mail'), claim.get('notices', []))
        minutes = min(15, max(1, math.ceil((time.time() - workflow_started) / 60)))
        await client.post(f'runner/batches/{batch_id}/complete', {'minutes': minutes})
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task

async def local_loop():
    # Reads a local, mode-0600 secret file. Nothing is placed in a URL or CLI argument.
    for _ in range(20):
        try:
            secrets = json.loads((ROOT / '.local/secrets.json').read_text())
            break
        except OSError:
            await asyncio.sleep(.5)
    else:
        raise RuntimeError('Local panel has not started')
    headers = {'X-Local-Runner': secrets['LOCAL_RUNNER_TOKEN'], 'X-Local-Run': str(uuid.uuid4())}
    client = Client('http://127.0.0.1:8787', local_headers=headers)
    print('本地原检测器执行器已连接。', flush=True)
    while True:
        try:
            queue = await asyncio.to_thread(client.request, 'runner/queue')
            if queue.get('batches'):
                await run_batch(client, queue['batches'][0]['id'], None, time.time())
        except Exception:
            print('执行器等待面板连接；稍后自动重试。', flush=True)
        await asyncio.sleep(3)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--local', action='store_true')
    args = parser.parse_args()
    stage = 'setup'
    try:
        if args.local:
            asyncio.run(local_loop())
        else:
            origin = os.environ['PANEL_ORIGIN'].rstrip('/')
            stage = 'identity'
            token = oidc_token(origin)
            stage = 'execution'
            asyncio.run(run_batch(Client(origin), os.environ['BATCH_ID'], token, float(os.environ.get('WORKFLOW_STARTED_AT', time.time()))))
    except Exception as error:
        raise SystemExit(cloud_failure_message(error, stage)) from None
