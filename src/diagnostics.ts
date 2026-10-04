import type { Report, RunStatus } from './shared.ts';

type ObjectValue = Record<string, unknown>;
export interface ReportIssue {
  code: string;
  httpStatus: number | null;
  title: string;
  summary: string;
  advice: string;
  count: number;
  detail: string;
  stage?: string;
}
function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
function string(value: unknown) { return typeof value === 'string' ? value.slice(0, 2048) : ''; }

export function classifyError(value: unknown): ReportIssue {
  const error = object(value), upstream = object(error.upstream), local = object(error.local);
  const code = string(error.code) || 'unknown_error';
  const httpStatus = typeof error.http_status === 'number' ? error.http_status : null;
  const detail = string(upstream.message) || string(local.message) || string(error.message);
  const upstreamCode = [upstream.type, upstream.code].filter(v => typeof v === 'string' || typeof v === 'number').join(' ').toLowerCase();
  const signal = `${upstreamCode} ${detail}`.toLowerCase();
  const issue: ReportIssue = { code, httpStatus, title: '请求失败', summary: '检测请求未完成，暂时无法获得有效证据。', advice: '展开错误详情查看上游回复，再检查地址、模型和协议。', count: 1, detail, stage: string(error.stage) || undefined };
  const set = (title: string, summary: string, advice: string) => Object.assign(issue, { title, summary, advice });
  // Prefer explicit upstream codes over guessing from a gateway HTTP status.
  const quota = /insufficient_quota|quota_exceeded|billing|余额不足|额度不足|欠费|余额已用完/.test(signal);
  const rate = /rate[_ -]?limit|too many requests|throttl|限流|请求过于频繁|并发.{0,8}(超|满)/.test(signal);
  if ((httpStatus === 429 || quota) && quota) return set('额度不足', '上游提示余额或请求额度不足。', '检查中转站余额、Key 配额和账户限额，补充额度后再检测。');
  if (httpStatus === 429 || rate) return set('请求被限流', `上游${httpStatus ? `返回 HTTP ${httpStatus} 并` : ''}限制了请求频率或并发。`, '稍后重试，降低监测频率；检查站点对这个 Key 的速率和并发限制。');
  if (httpStatus === 401) return set('API Key 验证失败', '上游未接受保存的 API Key，可能已失效或不属于此站点。', '在“编辑连接”中更新 Key，确认对应的站点和账号。');
  if (httpStatus === 403) return set('访问被拒绝', 'Key 权限、模型访问权限或站点的访问策略拒绝了请求。', '检查模型授权、IP 白名单以及中转站的访问限制。');
  if (httpStatus === 404) return set('接口或模型不存在', '上游返回 HTTP 404，通常表示 API 路径、请求协议或模型名称不匹配。', '确认 API 地址是否需要 /v1、协议是否受支持，以及实际请求模型名是否准确。');
  if (httpStatus === 400 || httpStatus === 422) return set('请求参数不兼容', '上游未接受检测请求的参数或指定模型。', '根据下面的上游回复检查模型名与协议；只支持 Chat 的站点请选择 Chat 兼容协议。');
  if (httpStatus === 408 || httpStatus === 504 || httpStatus === 524) return set('上游响应超时', '上游或网关没有在允许的时间内完成请求。', '稍后重试，检查站点可用性；当前已保存的有效样本仍可查看。');
  if (httpStatus === 503 || httpStatus === 529) return set('上游暂时不可用', '上游繁忙、维护中或没有可用线路，单凭此状态码无法确认限流。', '稍后重试或切换站点线路；如持续出现，查看上游消息并联系站点。');
  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 520 || httpStatus === 521 || httpStatus === 522 || httpStatus === 523) return set('上游服务或网关异常', '中转站服务、网关或其连接的模型服务发生错误。', '稍后重试，检查站点公告和线路状态。');
  if (httpStatus && httpStatus >= 300 && httpStatus < 400 || code === 'redirect_rejected') return set('接口发生重定向', '检测接口返回了跳转地址，执行器没有继续发送凭据。', '填写站点实际提供的 API 地址，避免使用登录页或跳转链接。');
  const rules: Record<string, [string, string, string]> = {
    dns_error: ['域名解析失败', '无法解析 API 域名，请求尚未到达模型服务。', '检查域名拼写、网络和 DNS；本地使用代理时确认代理已启动。'],
    proxy_dns_unavailable: ['本地代理未接入', '代理使用虚拟 DNS 地址，但检测器没有可用的 HTTP 代理。', '启动代理的 HTTP / mixed 端口，启用系统代理，然后重启本地预览。'],
    public_dns_unavailable: ['公网地址验证失败', '本地代理无法完成公网 DNS 验证，检测请求尚未发出。', '检查代理能否联网，确认 cloudflare-dns.com 可访问后重试。'],
    unsafe_destination: ['API 地址检查未通过', '域名指向内网、保留地址，或地址格式不符合公网 HTTPS 要求。', '填写公网 HTTPS API 地址；本地代理的虚拟 DNS 请通过系统 HTTP 代理连接。'],
    tls_error: ['HTTPS 连接失败', '证书校验或 TLS 握手失败，请求尚未获得模型回答。', '检查网络、代理和站点证书，保持证书校验开启。'],
    connection_error: ['无法连接上游', '与中转站的连接建立失败或中断。', '检查网络和代理是否可用，并确认站点 API 地址可以访问。'],
    request_timeout: ['请求超时', '部分请求超过等待时间，无法计入有效样本。', '稍后重试，检查站点响应速度；已有有效样本会保留。'],
    response_read_error: ['响应中途断开', '上游响应没有完整传回，可能是网络或网关中断。', '稍后重试，检查站点是否支持当前协议的流式响应。'],
    response_decode_error: ['响应无法解析', '上游响应的编码或压缩格式不能解析。', '查看上游回复，确认 API 地址和返回格式。'],
    response_too_large: ['响应超出限制', '上游返回的内容超过检测器允许的大小。', '确认请求到达的是模型 API，而不是网页或代理错误页。'],
    invalid_answer: ['回答格式不符合检测要求', '上游回答未能归入基准允许的类别，不能作为正常有效样本。', '确认协议与模型设置，查看其他有效样本；可选择更高档位补充证据。'],
    credential_echo: ['响应包含凭据', '上游响应包含敏感凭据，检测已停止并隐藏内容。', '检查 API 地址和服务配置，必要时更换 Key。'],
    credential_in_configuration: ['配置包含凭据', '地址或模型配置中包含 API Key，检测已停止。', '把 Key 仅填写在 API Key 栏，清理地址和模型名中的凭据。'],
    benchmark_error: ['基准校验失败', '固定版本基准文件不完整或校验值不一致，检测请求未发出。', '重新安装固定版本的检测器和基准后再试。'],
    detector_unavailable: ['检测器未就绪', '执行环境缺少检测器依赖或固定版本基准。', '完成检测器安装，或查看执行任务是否成功安装了固定版本。'],
    runner_error: ['检测执行异常', '执行器在检测完成前发生错误，已有证据已尽量保留。', '查看下方发生阶段和执行详情，修复执行环境后重试。'],
    runtime_failure: ['检测执行异常', '原检测器在执行中发生错误，已保存取得的证据。', '检查执行详情、检测器依赖与站点返回格式，再重试。'],
    samples_incomplete: ['有效样本不足', '有效样本没有达到基准要求，当前不能做出模型结论。', '先处理请求错误，再重新检测或选择更高档位。'],
    execution_timeout: ['检测超过时限', '任务达到 10 分钟上限，已保存取得的证据。', '检查请求错误和站点响应速度，必要时使用快速档重试。'],
  };
  return rules[code] ? set(...rules[code]) : issue;
}

export function reportIssues(report: Report | null | undefined, status?: RunStatus, fallback?: string | null): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const add = (error: unknown) => {
    const issue = classifyError(error);
    const existing = issues.find(v => v.code === issue.code && v.httpStatus === issue.httpStatus && v.title === issue.title && v.detail === issue.detail);
    if (existing) existing.count++; else issues.push(issue);
  };
  const results = Array.isArray(report?.results) ? report.results : [];
  for (const result of results) {
    const row = object(result);
    if (row.error && Object.keys(object(row.error)).length) add(row.error);
  }
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  for (const diagnostic of diagnostics) add(diagnostic);
  // Final result errors already include upstream evidence. Do not count their
  // event copies twice. Older/early failures can still be recovered from events.
  if (!issues.length && Array.isArray(report?.events)) {
    for (const event of report.events) {
      const item = object(event), payload = object(item.payload);
      if (item.type === 'run_error') add(payload);
      else if (payload.error) add(payload.error);
    }
  }
  if (report?.failure && !issues.some(issue => issue.code === report.failure)) add({ code: report.failure });
  if (status === 'timed_out') add({ code: 'execution_timeout' });
  if (!issues.length && status === 'failed') add({ code: 'unknown_error', message: fallback || '这份历史任务没有回传具体错误。请重新检测以获取错误详情。' });
  return issues.sort((a, b) => b.count - a.count);
}

export function fingerprintReason(value: string): string {
  const reasons: Record<string, string> = {
    samples_incomplete: '有效样本未达到基准要求',
    no_threshold: '没有候选模型达到判定线',
    multiple_thresholds: '多个候选模型达到判定线，无法唯一指向',
    no_valid_samples: '没有可用于比较的有效样本',
    baseline_cell_missing: '基准缺少对应探针数据',
    samples_exceed_plan: '样本数超过基准的计划范围',
    no_weighted_family: '没有可用于加权比较的样本类别',
    uncalibrated: '基准未校准，不能直接判定',
    no_match: '没有候选模型达到判定线',
    multiple_matches: '多个候选模型达到判定线，无法唯一指向',
    unknown_claimed_model: '申报模型尚未收录在基准中',
    insufficient_samples: '有效样本不足',
  };
  return reasons[value] || classifyError({ code: value }).title + `（${value}）`;
}
