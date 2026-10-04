import importlib.util
import asyncio
import ipaddress
import json
import contextlib
import io
import os
import sys
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.vendor'))
spec = importlib.util.spec_from_file_location('relay_execute', ROOT / 'runner/execute.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerTests(unittest.TestCase):
    def test_cloud_startup_errors_explain_stage_without_echoing_credentials(self):
        secret = 'private-token-never-print'
        failure = urllib.error.HTTPError('https://panel.example.com/?token=' + secret, 401, secret, {}, None)
        message = runner.cloud_failure_message(failure, 'execution')
        self.assertIn('领取任务与回传报告', message)
        self.assertIn('HTTP 401', message)
        self.assertNotIn(secret, message)
        self.assertNotIn('panel.example.com', message)
        for failure in [urllib.error.URLError(secret), KeyError(secret), ValueError(secret)]:
            with self.subTest(error=type(failure).__name__):
                message = runner.cloud_failure_message(failure, 'identity')
                self.assertIn('获取 GitHub 身份凭证', message)
                self.assertNotIn(secret, message)

    def test_disabled_email_never_connects(self):
        with patch.object(runner.smtplib, 'SMTP_SSL') as smtp:
            runner.send_notice('https://panel.example.com', {'enabled': False}, {})
            smtp.assert_not_called()

    def test_mail_has_private_report_link_and_correct_failure_label(self):
        notice = {'id': 'notice-1', 'kind': 'run', 'reports': [{'id': 'run-1', 'status': 'failed', 'snapshot': {'endpoint_name': '站点', 'target_name': 'GPT', 'logical_requests': 32}, 'report': {'fingerprint': {'verdict': 'match', 'valid_samples': 8, 'planned_samples': 32}}}]}
        message = runner.notice_message('https://panel.example.com', {'from': 'from@example.com', 'to': 'to@example.com'}, notice)
        self.assertIn('https://panel.example.com/?report=run-1', message.get_body(preferencelist=('plain',)).get_content())
        self.assertIn('请求失败', message.get_body(preferencelist=('plain',)).get_content())
        self.assertNotIn('GPT / 默认分组：支持申报模型', message.get_body(preferencelist=('plain',)).get_content())
        self.assertEqual(message['Message-ID'], '<relay-notice-1@panel.example.com>')

    def test_test_email_has_setup_result_and_private_link_without_model_results(self):
        notice = {'id': 'test-mail', 'kind': 'test', 'reports': []}
        message = runner.notice_message('https://panel.example.com', {'from': 'from@example.com', 'to': 'to@example.com'}, notice)
        self.assertIn('邮件配置测试', message['Subject'])
        self.assertIn('https://panel.example.com/', message.get_body(preferencelist=('plain',)).get_content())
        self.assertIn('没有调用模型 API', message.get_body(preferencelist=('plain',)).get_content())
        self.assertNotIn('有效样本', message.get_body(preferencelist=('plain',)).get_content())

    def test_batch_mail_groups_same_url_sorts_by_availability_and_score_and_bolds_results(self):
        def report(identity, url, station, score, state='match', status='completed', samples=32):
            return {'id': identity, 'status': status, 'attempts': 32, 'ended_at': 1791050400000,
                    'snapshot': {'base_url': url, 'station_name': station, 'endpoint_name': station + ' / Key', 'target_name': identity, 'group_name': '0.08', 'request_model': 'relay-alias', 'claimed_model': 'gpt-6.1-sol', 'tier': 'low', 'logical_requests': 32},
                    'api_key': 'fixture-should-never-appear',
                    'report': {'fingerprint': {'matches': {'gpt-6.1-sol': score}, 'thresholds': {'gpt-6.1-sol': .6}, 'verdict': state, 'valid_samples': samples, 'planned_samples': 32}}}
        reports = [report('失败目标', 'https://same.example.com', '中转 A', .99, status='failed'),
                   report('低匹配目标', 'https://same.example.com', '中转 A', .31, 'mismatch'),
                   report('最高匹配目标', 'https://same.example.com', '另一条 Key 名称', .92),
                   report('零样本目标', 'https://same.example.com', '中转 A', .98, samples=0),
                   report('Claude 目标', 'https://other.example.com', '中转 B', .6, 'insufficient')]
        settings = {'from': 'from@example.com', 'to': 'to@example.com', 'password': 'fixture-should-never-appear'}
        message = runner.notice_message('https://panel.example.com', settings, {'id': 'summary', 'kind': 'batch', 'reports': reports})
        plain = message.get_body(preferencelist=('plain',)).get_content()
        html = message.get_body(preferencelist=('html',)).get_content()
        self.assertEqual(html.count('<table '), 2)
        self.assertLess(html.index('<strong>最高匹配目标</strong>'), html.index('<strong>低匹配目标</strong>'))
        self.assertLess(html.index('<strong>低匹配目标</strong>'), html.index('<strong>失败目标</strong>'))
        self.assertIn('92.0%', html)
        self.assertIn('31.0%', plain)
        self.assertIn('判定线 60.0%', html)
        for label in ['支持申报模型', '强指向其他模型', '证据不足']:
            self.assertRegex(html, r'<strong[^>]*>' + label + '</strong>')
        self.assertIn('https://panel.example.com/?report=', html)
        self.assertNotIn('fixture-should-never-appear', html + plain)
        self.assertIn('检测汇总', message['Subject'])

    def test_single_report_uses_the_same_table_with_zero_percent_and_escaped_names(self):
        report = {'id': 'safe-id', 'status': 'completed', 'attempts': 32,
                  'snapshot': {'target_name': '<script>alert(1)</script>', 'station_name': 'A & B', 'claimed_model': 'model', 'request_model': 'model', 'logical_requests': 32},
                  'report': {'fingerprint': {'matches': {'model': 0}, 'verdict': 'mismatch', 'valid_samples': 32, 'planned_samples': 32}}}
        message = runner.notice_message('https://panel.example.com', {'from': 'from@example.com', 'to': 'to@example.com'}, {'id': 'single', 'kind': 'batch', 'reports': [report]})
        html = message.get_body(preferencelist=('html',)).get_content()
        self.assertIn('0.0%', html)
        self.assertIn('&lt;script&gt;', html)
        self.assertNotIn('<script>', html)
        self.assertIn('A &amp; B', html)
        self.assertEqual(html.count('<table '), 1)

    def test_five_shared_host_jobs_start_together_and_mail_waits_for_every_job(self):
        class Collector:
            origin = 'https://panel.example.com'
            lease = ''
            def __init__(self): self.saved, self.events = [], []
            def request(self, path, payload, oidc):
                return {'kind': 'detection', 'lease': 'fixture-lease', 'jobs': [{'id': str(i), 'config': {'base_url': 'https://same.example.com'}} for i in range(5)]}
            async def post(self, path, payload):
                self.events.append(path)
                if path.endswith('/notices'):
                    if len(self.saved) != 5: raise AssertionError('mail requested before completion')
                    return {'mail': None, 'notices': []}
                return {'ok': True}
        async def scenario():
            client, entered, gate = Collector(), set(), asyncio.Event()
            async def execute(client, batch, job, deadline):
                entered.add(job['id'])
                if len(entered) == 5: gate.set()
                await gate.wait()
                client.saved.append(job['id'])
            with patch.object(runner, 'execute_job', side_effect=execute), patch.object(runner, 'mask_secret'):
                await asyncio.wait_for(runner.run_batch(client, 'batch', None, time.time()), 2)
            self.assertEqual(len(client.saved), 5)
            self.assertTrue(client.events[-1].endswith('/complete'))
        asyncio.run(scenario())

    def test_failed_result_submission_waits_for_other_targets_and_hides_error_secrets(self):
        secret = 'fixture-provider-secret-never-log'
        class Collector:
            origin = 'https://panel.example.com'
            lease = ''
            def __init__(self): self.saved, self.events = [], []
            def request(self, path, payload, oidc):
                return {'kind': 'detection', 'lease': 'fixture-lease', 'jobs': [{'id': str(i)} for i in range(3)]}
            async def post(self, path, payload):
                self.events.append(path)
                if path.endswith('/results/0'):
                    raise RuntimeError('provider response echoed ' + secret)
                if '/results/' in path:
                    self.saved.append(path.rsplit('/', 1)[1])
                return {'ok': True}
        async def scenario():
            client, entered, gate = Collector(), set(), asyncio.Event()
            async def execute(client, batch, job, deadline):
                entered.add(job['id'])
                if len(entered) == 3: gate.set()
                await gate.wait()
                if job['id'] != '0': await asyncio.sleep(.02)
                await client.post(f'runner/batches/{batch}/results/' + job['id'], {'status': 'completed'})
            captured = io.StringIO()
            with patch.object(runner, 'execute_job', side_effect=execute), patch.object(runner, 'mask_secret'), contextlib.redirect_stdout(captured):
                with self.assertRaises(RuntimeError) as rejected:
                    await asyncio.wait_for(runner.run_batch(client, 'batch', None, time.time()), 2)
            self.assertCountEqual(client.saved, ['1', '2'])
            self.assertEqual(str(rejected.exception), '部分检测结果回传失败；其余已提交报告仍保存在面板。')
            self.assertFalse(any(path.endswith('/notices') or path.endswith('/complete') for path in client.events))
            self.assertNotIn(secret, captured.getvalue() + str(rejected.exception) + runner.cloud_failure_message(rejected.exception, 'execution'))
        asyncio.run(scenario())

    def test_all_recipients_are_in_mail_and_partial_refusal_is_not_reported_as_success(self):
        settings = {'enabled': True, 'host': 'smtp.example.com', 'port': 465, 'username': 'from@example.com', 'password': 'fixture-private-code', 'from': 'from@example.com', 'to': 'one@example.com, two@example.com'}
        notice = {'id': 'mail-multi', 'kind': 'test', 'reports': []}
        with patch.object(runner, 'public_host'), patch.object(runner, 'mask_secret'), patch.object(runner.smtplib, 'SMTP_SSL') as connection:
            smtp = connection.return_value
            smtp.send_message.return_value = {}
            runner.send_notice('https://panel.example.com', settings, notice)
            message = smtp.send_message.call_args.args[0]
            self.assertEqual(str(message['To']), settings['to'])
            self.assertNotIn(settings['password'], message.get_body(preferencelist=('plain',)).get_content())
            smtp.send_message.return_value = {'two@example.com': (550, b'rejected')}
            with self.assertRaises(runner.smtplib.SMTPRecipientsRefused):
                runner.send_notice('https://panel.example.com', settings, notice)

    def test_quit_failure_does_not_invalidate_an_email_already_accepted_by_smtp(self):
        settings = {'enabled': True, 'host': 'smtp.example.com', 'port': 465, 'username': 'from@example.com', 'password': 'fixture-private-code', 'from': 'from@example.com', 'to': 'one@example.com'}
        with patch.object(runner, 'public_host'), patch.object(runner, 'mask_secret'), patch.object(runner.smtplib, 'SMTP_SSL') as connection:
            smtp = connection.return_value
            smtp.send_message.return_value = {}
            smtp.quit.side_effect = runner.smtplib.SMTPResponseException(-1, b'\x00\x00\x00')
            runner.send_notice('https://panel.example.com', settings, {'id': 'mail', 'kind': 'test', 'reports': []})
            smtp.send_message.assert_called_once()
            smtp.close.assert_called_once()
            smtp.login.side_effect = runner.smtplib.SMTPAuthenticationError(535, b'private-code')
            with self.assertRaises(runner.smtplib.SMTPAuthenticationError):
                runner.send_notice('https://panel.example.com', settings, {'id': 'mail', 'kind': 'test', 'reports': []})

    def test_qq_uses_advertised_login_challenge_and_preserves_authentication_rejection(self):
        settings = {'enabled': True, 'host': 'smtp.qq.com', 'port': 465, 'username': 'from@qq.com', 'password': 'fixture-private-code', 'from': 'from@qq.com', 'to': 'one@example.com'}
        with patch.object(runner, 'public_host'), patch.object(runner, 'mask_secret'), patch.object(runner.smtplib, 'SMTP_SSL') as connection:
            smtp = connection.return_value
            smtp.esmtp_features = {'auth': 'LOGIN PLAIN LOGIN'}
            smtp.send_message.return_value = {}
            runner.send_notice('https://panel.example.com', settings, {'id': 'mail', 'kind': 'test', 'reports': []})
            smtp.auth.assert_called_once_with('LOGIN', smtp.auth_login, initial_response_ok=False)
            smtp.login.assert_not_called()
            smtp.auth.side_effect = runner.smtplib.SMTPAuthenticationError(535, b'fixture-private-code')
            with self.assertRaises(runner.smtplib.SMTPAuthenticationError) as rejected:
                runner.send_notice('https://panel.example.com', settings, {'id': 'mail', 'kind': 'test', 'reports': []})
            self.assertEqual(rejected.exception.relay_smtp_phase, 'authentication')

    def test_smtp_error_is_classified_without_echoing_provider_response_or_credentials(self):
        class Collector:
            origin = 'https://panel.example.com'
            def __init__(self): self.results = []
            async def post(self, path, payload):
                self.results.append((path, payload))
                return {'send': True}
        cases = [
            (runner.smtplib.SMTPAuthenticationError(535, b'private-password'), 'smtp_auth'),
            (runner.smtplib.SMTPAuthenticationError(502, b'private-password'), 'smtp_protocol'),
            (runner.smtplib.SMTPRecipientsRefused({'to@example.com': (550, b'private-password')}), 'smtp_recipient'),
            (runner.smtplib.SMTPDataError(421, b'private-password'), 'smtp_busy'),
            (runner.smtplib.SMTPDataError(550, b'private-password'), 'smtp_rejected'),
            (runner.smtplib.SMTPResponseException(-1, b'private-password'), 'smtp_protocol'),
            (TimeoutError('private-password'), 'smtp_connect'),
            (runner.ssl.SSLError('private-password'), 'smtp_tls'),
        ]
        for error, code in cases:
            with self.subTest(code=code):
                collector = Collector()
                captured = io.StringIO()
                with patch.object(runner, 'send_notice', side_effect=error), contextlib.redirect_stdout(captured):
                    asyncio.run(runner.deliver_notices(collector, 'batch', {'enabled': True}, [{'id': 'notice'}]))
                result = collector.results[-1][1]
                self.assertEqual(result['error_code'], code)
                self.assertFalse(result['ok'])
                self.assertNotIn('private-password', captured.getvalue())
                self.assertNotIn('private-password', json.dumps(collector.results))

    def test_private_dns_and_insecure_origins_rejected(self):
        with patch.object(runner.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('169.254.169.254', 443))]):
            with self.assertRaises(ValueError): runner.public_host('https://api.example.com')
        with self.assertRaises(ValueError): runner.public_host('http://api.example.com')
        with self.assertRaises(ValueError): runner.Client('http://panel.example.com')

    def test_actual_attempt_count_and_conservative_unknown_accounting(self):
        self.assertEqual(runner.attempts_in({'progress': {'actual_attempts': 17}}, 48), 17)
        self.assertEqual(runner.attempts_in({'progress': {'actual_attempts': 1000}}, 48), 48)
        self.assertEqual(runner.attempts_in({}, 48), 48)

    def test_fake_dns_requires_local_proxy_and_verified_public_dns(self):
        fake = [(2, 1, 6, '', ('198.19.0.43', 443))]
        with patch.object(runner.socket, 'getaddrinfo', return_value=fake), patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:1082', 'NO_PROXY': ''}, clear=True), patch.object(runner, 'public_dns_addresses', return_value=[ipaddress.ip_address('8.8.8.8')]) as dns:
            with self.assertRaises(runner.ExecutionError): runner.public_host('https://api.example.com')
            dns.assert_not_called()
            runner.public_host('https://api.example.com', local=True)
            dns.assert_called_once_with('api.example.com')
        with patch.object(runner.socket, 'getaddrinfo', return_value=fake), patch('gpt56_vnext.proxies.resolve_proxy') as resolve, patch.object(runner, 'public_dns_addresses') as dns:
            resolve.return_value.proxy_url = None
            with self.assertRaisesRegex(runner.ExecutionError, 'proxy_dns_unavailable'): runner.public_host('https://api.example.com', local=True)
            dns.assert_not_called()

    def test_proxy_never_allows_private_public_dns_or_non_fake_private_address(self):
        with patch.object(runner.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('198.18.0.5', 443))]), patch('gpt56_vnext.proxies.resolve_proxy') as resolve, patch.object(runner, 'public_dns_addresses', return_value=[ipaddress.ip_address('10.0.0.1')]):
            resolve.return_value.proxy_url = 'http://127.0.0.1:1082'
            with self.assertRaisesRegex(runner.ExecutionError, 'unsafe_destination'): runner.public_host('https://api.example.com', local=True)
        with patch.object(runner.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.1', 443))]), patch.object(runner, 'public_dns_addresses') as dns:
            with self.assertRaises(runner.ExecutionError): runner.public_host('https://api.example.com', local=True)
            dns.assert_not_called()

    def test_local_tun_still_requires_public_dns_and_never_changes_cloud_policy(self):
        fake = [(2, 1, 6, '', ('198.18.0.5', 443))]
        with patch.object(runner.socket, 'getaddrinfo', return_value=fake), patch.dict(os.environ, {'RELAY_LOCAL_NETWORK_MODE': 'tun', 'NO_PROXY': '*'}, clear=True), patch.object(runner, 'public_dns_addresses', return_value=[ipaddress.ip_address('8.8.8.8')]) as dns:
            runner.public_host('https://api.example.com', local=True)
            with self.assertRaisesRegex(runner.ExecutionError, 'unsafe_destination'): runner.public_host('https://api.example.com')
            self.assertEqual(dns.call_count, 1)

    def test_shadowrocket_mixed_ipv4_and_translated_ipv6_no_longer_blocks_local_runs(self):
        combinations = [
            ['198.18.0.43', '::ffff:0:c612:2b'],
            ['::ffff:0:c612:2b'],
            ['198.18.0.43', '::ffff:198.18.0.43'],
            ['198.18.0.43', '64:ff9b::c612:2b'],
            ['198.18.0.43', '2606:4700:3034::ac43:9681'],
        ]
        for addresses in combinations:
            with self.subTest(addresses=addresses):
                resolved = [(10 if ':' in address else 2, 1, 6, '', (address, 443)) for address in addresses]
                with patch.object(runner.socket, 'getaddrinfo', return_value=resolved), patch.dict(os.environ, {'RELAY_LOCAL_NETWORK_MODE': 'tun', 'NO_PROXY': '*'}, clear=True), patch.object(runner, 'public_dns_addresses', return_value=[ipaddress.ip_address('104.21.90.4')]) as dns:
                    runner.public_host('https://api.example.com', local=True)
                    dns.assert_called_once_with('api.example.com')
                    with self.assertRaisesRegex(runner.ExecutionError, 'unsafe_destination'):
                        runner.public_host('https://api.example.com')

    def test_embedded_private_ipv4_never_bypasses_address_checks(self):
        addresses = ['::ffff:127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::a00:1', 'ff02::1', 'fec0::1']
        for address in addresses:
            with self.subTest(address=address):
                self.assertFalse(runner.public_address(address))
                with patch.object(runner.socket, 'getaddrinfo', return_value=[(10, 1, 6, '', (address, 443))]), patch.dict(os.environ, {'RELAY_LOCAL_NETWORK_MODE': 'tun', 'NO_PROXY': '*'}, clear=True), patch.object(runner, 'public_dns_addresses') as dns:
                    with self.assertRaisesRegex(runner.ExecutionError, 'unsafe_destination'):
                        runner.public_host('https://api.example.com', local=True)
                    dns.assert_not_called()
        with patch.object(runner.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('198.18.0.43', 443))]), patch.dict(os.environ, {'RELAY_LOCAL_NETWORK_MODE': 'tun', 'NO_PROXY': '*'}, clear=True), patch.object(runner, 'public_dns_addresses', return_value=[ipaddress.ip_address('::ffff:0:7f00:1')]):
            with self.assertRaisesRegex(runner.ExecutionError, 'unsafe_destination'):
                runner.public_host('https://api.example.com', local=True)

    def test_early_failure_is_reported_without_exception_secret(self):
        class Collector:
            local_headers = {'test': 'local'}
            async def post(self, path, payload): self.result = payload
        collector = Collector()
        job = {'id': 'test', 'config': {'base_url': 'https://api.example.com'}, 'api_key': 'private-key-never-print', 'maximum_attempts': 48}
        with patch.object(runner, 'public_host', side_effect=ValueError('provider echoed private-key-never-print')):
            asyncio.run(runner.execute_job(collector, 'batch', job, time.monotonic() + 10))
        self.assertEqual(collector.result['status'], 'failed')
        self.assertEqual(collector.result['attempts'], 0)
        self.assertEqual(collector.result['report']['diagnostics'][0]['stage'], 'address_check')
        self.assertNotIn('private-key-never-print', json.dumps(collector.result))

if __name__ == '__main__': unittest.main()
