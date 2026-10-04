"""Small HTML summaries. Only selected report fields enter email bodies."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from html import escape
import math
import urllib.parse

LABELS = {'match': '支持申报模型', 'mismatch': '强指向其他模型', 'insufficient': '证据不足'}
TIERS = {'low': '快速', 'medium': '标准', 'high': '深度'}

def fingerprint(report: dict) -> dict:
    return (report.get('report') or {}).get('fingerprint') or {}

def claimed_score(report: dict) -> float | None:
    evidence = fingerprint(report)
    score = evidence.get('matches', {}).get(report['snapshot'].get('claimed_model'))
    if evidence.get('valid_samples', 0) > 0 and type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 1:
        return score
    return None

def result_label(report: dict) -> str:
    if report['status'] == 'failed': return '请求失败或检测未完成'
    if report['status'] == 'timed_out': return '检测超时，已保存部分证据'
    if report['status'] != 'completed': return '检测未完成'
    evidence = fingerprint(report)
    return LABELS.get(evidence.get('verdict'), '证据不足') if evidence.get('valid_samples', 0) > 0 else '证据不足'

def availability_order(report: dict) -> tuple:
    evidence = fingerprint(report)
    available = report['status'] == 'completed' and evidence.get('valid_samples', 0) > 0
    rank = 0 if available else 1 if report['status'] == 'completed' else 2 if report['status'] == 'timed_out' else 3
    score = claimed_score(report)
    return (rank, -(score if score is not None else -1), report['snapshot'].get('target_name', ''), report['id'])

def report_time(report: dict) -> str:
    milliseconds = report.get('ended_at') or report.get('created_at')
    if type(milliseconds) not in (int, float): return '时间未记录'
    return datetime.fromtimestamp(milliseconds / 1000, timezone(timedelta(hours=8))).strftime('%m/%d %H:%M')

def notice_message(origin: str, settings: dict, notice: dict) -> EmailMessage:
    message = EmailMessage()
    reports = notice.get('reports', [])
    title = {'daily': '每日检测汇总', 'test': '邮件配置测试'}.get(notice['kind'], '检测汇总' if len(reports) > 1 else '检测结果')
    message['Subject'] = 'Relay Desk · ' + title
    message['From'], message['To'] = settings['from'], settings['to']
    message['Message-ID'] = '<relay-' + notice['id'] + '@' + urllib.parse.urlsplit(origin).hostname + '>'
    panel_url = origin.rstrip('/') + '/'
    secrets = [settings.get('password', '')]
    def clean(value) -> str:
        text = str(value)
        for secret in secrets:
            if secret: text = text.replace(secret, '[REDACTED]')
        return text
    def safe(value) -> str: return escape(clean(value), quote=True)
    lines, html = [], ['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media(max-width:480px){body{padding:8px!important}.mail-content{padding:12px!important}td,th{padding:6px!important}}</style></head><body style="margin:0;padding:20px;background:#f5f6f1;color:#29332e;font-family:Arial,PingFang SC,sans-serif"><div class="mail-content" style="max-width:820px;margin:auto;padding:24px;background:#ffffff;border:1px solid #e1e6db;border-radius:12px">', f'<h1 style="font-size:22px;margin:0 0 14px">Relay Desk · {safe(title)}</h1>']
    if notice['kind'] == 'test':
        lines.extend(['这是一封 Relay Desk 测试邮件。收到此邮件说明发件邮箱配置已连接成功。', '私人面板：' + panel_url, '本次邮件测试没有调用模型 API。'])
        html.extend(['<p>收到这封邮件说明发件邮箱配置已连接成功。</p>', '<p>本次邮件测试没有调用模型 API。</p>', f'<p><a href="{safe(panel_url)}">打开私人面板</a></p>'])
    else:
        matched = sum(result_label(report) == LABELS['match'] for report in reports)
        summary = f'本次共 {len(reports)} 份报告 · {matched} 个支持申报模型 · 全部检测已结束'
        lines.append(summary)
        html.append(f'<p style="color:#6d7a69;font-size:13px">{safe(summary)}</p>')
        grouped: dict[str, list] = {}
        for report in reports:
            snapshot = report['snapshot']
            station = snapshot.get('base_url') or snapshot.get('station_name') or snapshot.get('endpoint_name', '中转站')
            grouped.setdefault(station, []).append(report)
        sections = [sorted(group, key=availability_order) for group in grouped.values()]
        sections.sort(key=lambda group: (availability_order(group[0]), group[0]['snapshot'].get('station_name', '')))
        for group in sections:
            snap = group[0]['snapshot']
            station_name = snap.get('station_name') or snap.get('endpoint_name', '中转站').split(' / ')[0]
            lines.extend(['', f'【{clean(station_name)}】（{len(group)} 个结果）'])
            html.extend([f'<h2 style="font-size:17px;margin:24px 0 10px">{safe(station_name)} <small style="color:#84927b;font-size:12px">{len(group)} 个结果</small></h2>', '<table cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12px;line-height:1.6;word-break:break-word"><thead><tr style="background:#eef2e7;text-align:left"><th scope="col">模型 / 分组</th><th scope="col">申报匹配度</th><th scope="col">检测结论</th><th scope="col">样本 / 请求</th><th scope="col">报告</th></tr></thead><tbody>'])
            for report in group:
                snapshot, evidence = report['snapshot'], fingerprint(report)
                score = claimed_score(report)
                percent = f'{score * 100:.1f}%' if score is not None else '—'
                state = result_label(report)
                valid, planned = evidence.get('valid_samples', 0), evidence.get('planned_samples', snapshot.get('logical_requests', 0))
                threshold = evidence.get('thresholds', {}).get(snapshot.get('claimed_model'))
                threshold_text = f'判定线 {threshold * 100:.1f}%' if type(threshold) in (int, float) and math.isfinite(threshold) and 0 <= threshold <= 1 else '判定线未记录'
                link = panel_url + '?report=' + urllib.parse.quote(report['id'], safe='')
                model = snapshot.get('request_model', snapshot.get('target_name', '模型'))
                claimed = snapshot.get('claimed_model', '未记录')
                name, group_name = snapshot.get('target_name', model), snapshot.get('group_name', '默认分组')
                tier = TIERS.get(snapshot.get('tier'), '未记录')
                when = report_time(report)
                lines.extend([f'{clean(name)} / {clean(group_name)}：{state} · 申报匹配度 {percent}', f'请求模型：{clean(model)}；申报模型：{clean(claimed)}；{tier}档', f'有效样本：{valid} / {planned}；实际请求：{report.get("attempts", "未记录")}；{threshold_text}；北京时间 {when}', link, ''])
                color = '#47745b' if state == LABELS['match'] else '#ad6452' if report['status'] != 'completed' or state == LABELS['mismatch'] else '#8b7951'
                html.append('<tr style="border-bottom:1px solid #e5e9de">' +
                    f'<td><strong>{safe(name)}</strong><br>{safe(group_name)} · {safe(tier)}档<br><span style="color:#7b8875">请求：{safe(model)}<br>申报：{safe(claimed)}</span></td>' +
                    f'<td><strong style="font-size:17px;white-space:nowrap">{safe(percent)}</strong><br><span style="color:#7b8875">{safe(threshold_text)}</span></td>' +
                    f'<td><strong style="color:{color}">{safe(state)}</strong></td>' +
                    f'<td>{safe(valid)} / {safe(planned)} 有效<br>{safe(report.get("attempts", "未记录"))} 次请求<br><span style="color:#7b8875">{safe(when)} 北京时间</span></td>' +
                    f'<td><a href="{safe(link)}" style="color:#47745b">查看</a></td></tr>')
            html.append('</tbody></table>')
        lines.append('可完成检测的目标在前，同一中转站内按申报模型匹配度从高到低排序；失败或超时保留明确状态。')
        html.append('<p style="font-size:12px;color:#7b8875;margin-top:22px">可完成检测的目标在前，同一中转站内按申报模型匹配度从高到低排序；失败或超时保留明确状态。</p>')
    footer = '匹配度是模型行为指纹证据，不是身份概率。详细结果请登录私人面板查看。'
    lines.append(footer)
    html.extend([f'<p style="font-size:12px;color:#87927f">{safe(footer)}</p>', '</div></body></html>'])
    message.set_content('\n'.join(lines))
    message.add_alternative(''.join(html), subtype='html')
    return message
