import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, Download, FileText, Folder, Layers3, LockKeyhole, Mail, Menu, Pencil, Play, Plus, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Trash2, X, Zap } from 'lucide-react';
import { api } from './api.ts';
import BatchTargetForm from './BatchTargetForm.tsx';
import ConnectionContext from './ConnectionContext.tsx';
import { RunPresetForm, RunPresetList } from './RunPresets.tsx';
import { derivePasswordProof, type PasswordParameters } from './password.ts';
import { fingerprintReason, reportIssues } from './diagnostics.ts';
import { detectionMailState, detectionOverview } from './detection-progress.ts';
import { isTargetSort, latestTargetRun, sortTargets, TARGET_SORTS, type TargetSort } from './target-sorting.ts';
import { BASELINES, baselineFor, defaultRequestModel, appliesTo, comparisonKey, plannedRequests, PROTOCOL_LABEL, TIER_LABEL, VERDICT_LABEL, endpointsInScope, targetsInScope, recipientAddresses, type Endpoint, type Group, type PanelData, type Protocol, type Run, type RunPreset, type Schedule, type Target, type Tier } from './shared.ts';
type Page = 'overview' | 'stations' | 'reports' | 'schedules' | 'settings';
type SelectionMode = 'detect' | 'edit' | null;
type DialogState = { kind: 'preset'; value?: RunPreset; targetIds?: string[] } | { kind: 'delete-preset'; value: RunPreset } | { kind: 'batch-target'; targetIds: string[] } | { kind: 'station'; value: Endpoint } | { kind: 'endpoint'; value?: Endpoint; sameAs?: Endpoint } | { kind: 'target'; value?: Target; endpoint?: string } | { kind: 'group'; value?: Group } | { kind: 'groups' } | { kind: 'delete-group'; value: Group } | { kind: 'schedule'; value: Target } | { kind: 'report'; value: Run } | null;
interface Session { authenticated: boolean; login: string | null; local: boolean; configured: boolean; password_kdf: PasswordParameters | null }
const PAGE_INFO: Record<Page, { name: string; description: string; icon: typeof Activity }> = {
 overview: { name: '检测总览', description: '查看最近结果，或开始一次新的检测。', icon: Activity },
 stations: { name: '站点与模型', description: '保存连接后，各设备都能直接开始检测。', icon: Server },
 reports: { name: '检测报告', description: '每次检测的证据、结果与历史变化。', icon: FileText },
 schedules: { name: '监测计划', description: '按需开启，云端自动执行。', icon: Clock3 },
 settings: { name: '设置', description: '用量上限、邮件通知与桌面入口。', icon: Settings2 },
};
const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function date(time: number | null) { return time ? DATE_FORMAT.format(time) : '—'; }
function age(time: number | null) { if (!time) return '尚未检测'; const minutes = Math.floor((Date.now() - time) / 60000); return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`; }
function isActive(run: Run) { return ['queued', 'running'].includes(run.status); }
function reportLabel(run?: Run) { if (!run) return '尚未检测'; if (isActive(run)) return run.status === 'running' ? '检测中' : '排队中'; if (run.status === 'timed_out') return '检测超时'; if (run.status === 'failed') return '请求失败'; return run.report?.fingerprint ? VERDICT_LABEL[run.report.fingerprint.verdict] : '证据不足'; }
function verdictClass(run?: Run) { if (!run) return 'neutral'; if (isActive(run)) return 'running'; if (run.status !== 'completed') return 'error'; return run.report?.fingerprint?.verdict || 'insufficient'; }
function exportRun(run: Run) { const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `relay-report-${run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
function Badge({ run }: { run?: Run }) { return <span className={`badge ${verdictClass(run)}`}><span className="status-dot" />{reportLabel(run)}</span>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Empty({ icon: Icon = Layers3, title, description, children }: { icon?: typeof Layers3; title: string; description: string; children?: ReactNode }) { return <div className="empty"><div className="empty-mark"><Icon size={30} strokeWidth={1.5} /></div><h3>{title}</h3><p>{description}</p>{children}</div>; }
function Dialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
 const dialog = useRef<HTMLDialogElement>(null);
 useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
 return <dialog ref={dialog} className={`dialog ${wide ? 'wide' : ''}`} onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}><div className="dialog-head"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="关闭"><X size={20} /></button></div>{children}</dialog>;
}
function LoginForm({ session, loggedIn }: { session: Session; loggedIn: () => Promise<void> }) {
 const [busy, setBusy] = useState(false); const [error, setError] = useState('');
 return <div className="login-screen"><div className="login-card"><img src="/icon.svg" alt="" /><span className="eyebrow">YOUR PRIVATE RELAY DESK</span><h1>你的中转站，<br />随时查。</h1><p>保存一次连接，一键检测模型指纹。<br />报告与凭据仅对你开放。</p>
  <form className="login-form" onSubmit={async e => {
   e.preventDefault(); if (busy || !session.password_kdf) return; const form = e.currentTarget; const fields = new FormData(form);
   setBusy(true); setError('');
   try {
    const proof = await derivePasswordProof(String(fields.get('password') || ''), session.password_kdf);
    await api('auth/login', 'POST', { email: fields.get('email'), proof }); form.reset(); await loggedIn();
   } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>
   <Field label="账号"><input name="email" type="email" inputMode="email" autoComplete="username" placeholder="输入你的邮箱账号" required maxLength={254} autoFocus /></Field>
   <Field label="密码"><input name="password" type="password" autoComplete="current-password" placeholder="输入面板登录密码" required maxLength={1024} /></Field>
   {error && <div className="note error-text" role="alert">{error}</div>}
   {!session.configured && <div className="note">账号密码登录尚未配置，请先完成部署设置。</div>}
   <button className="button primary" disabled={busy || !session.configured}><LockKeyhole size={17} />{busy ? '登录中…' : '登录私人面板'}</button>
  </form><div className="login-foot"><ShieldCheck size={14} />保持登录 30 天 · 仅限私人账号访问</div>
 </div></div>;
}
export default function App() {
 const [session, setSession] = useState<Session | null>(null);
 const [data, setData] = useState<PanelData | null>(null); const [page, setPage] = useState<Page>('overview'); const [group, setGroup] = useState('all');
 const [filterBy, setFilterBy] = useState<'group' | 'station'>('group'); const [station, setStation] = useState('all');
 const [selectionMode, setSelectionMode] = useState<SelectionMode>(null); const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
 useEffect(() => { setSelectionMode(null); setSelectedTargets([]); }, [filterBy, group, station, page]);
 const [sortBy, setSortBy] = useState<TargetSort>(() => { try { const value = localStorage.getItem('relay-target-sort'); return isTargetSort(value) ? value : 'default'; } catch { return 'default'; } });
 const changeSort = (value: TargetSort) => { setSortBy(value); try { localStorage.setItem('relay-target-sort', value); } catch { /* 排序仍可用于当前页面。 */ } };
 const [dialog, setDialog] = useState<DialogState>(null); const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [reportTarget, setReportTarget] = useState('all');
 const openedReportLink = useRef(false);
 const notify = useCallback((text: string, error = false) => { setToast({ text, error }); }, []);
 const reload = useCallback(async () => { const result = await api<PanelData>('panel'); setData(result); setError(''); }, []);
 useEffect(() => { api<NonNullable<typeof session>>('session').then(async value => { setSession(value); if (value.authenticated) await reload(); }).catch(e => setError(e.message)); }, [reload]);
 useEffect(() => { if (!session?.authenticated) return; const timer = setInterval(() => { if (document.visibilityState === 'visible') reload().catch(e => setError(e.message)); }, 7000); return () => clearInterval(timer); }, [session?.authenticated, reload]);
 useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer); }, [toast]);
 useEffect(() => {
  const reportId = new URLSearchParams(location.search).get('report');
  if (!data || !reportId || openedReportLink.current) return;
  openedReportLink.current = true;
  api<{ runs: Run[] }>('runs/' + encodeURIComponent(reportId)).then(result => { const run = result.runs.find(r => r.id === reportId); if (run) { setPage('reports'); setDialog({ kind: 'report', value: run }); } }).catch(e => notify(e.message, true));
 }, [data, notify]);
 const createGroup = async (name: string) => { const result = await api<{ id: string }>('groups', 'POST', { name }); await reload(); return result.id; };
 const save = async (path: string, method: string, body: unknown) => {
  setBusy(true);
  try {
   const result = await api<{ id?: string; base_url?: string; updated?: number }>(path, method, body); if (method === 'DELETE' && path.startsWith('groups/')) setGroup('all'); if (path.startsWith('stations/') && dialog?.kind === 'station' && station === dialog.value.base_url && result.base_url) setStation(result.base_url); await reload();
   if (path === 'endpoints' && dialog?.kind === 'endpoint' && !dialog.value && result.id) {
    setDialog({ kind: 'target', endpoint: result.id }); notify('站点已保存，继续添加检测模型');
   } else if (path === 'targets/batch') { setDialog(null); setSelectionMode(null); setSelectedTargets([]); notify(`已更新 ${result.updated} 个模型配置，下次检测生效`); }
   else if (path === 'run-presets' || path.startsWith('run-presets/')) { setDialog(null); setSelectionMode(null); setSelectedTargets([]); setPage('overview'); notify(method === 'DELETE' ? '常用组合已删除，模型配置与报告保留' : '常用组合已保存，可以一键检测'); }
   else { setDialog(null); notify(method === 'DELETE' ? '分组已删除，站点已移回默认分组' : '设置已保存'); }
  } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
 };
 const start = async (ids: string[], tier?: Tier) => {
  if (!ids.length || busy) return;
  if (data?.preview_only) { notify('当前使用示例数据预览布局；确认并发布后，可在正式面板发起检测。'); return; }
  const supported = ids.filter(id => { const t = data?.targets.find(t => t.id === id); return t && BASELINES[t.protocol].models.includes(t.claimed_model); });
  const skipped = ids.length - supported.length; if (!supported.length) { notify('所选模型均暂无对应基准，暂不支持检测', true); return; }
  setBusy(true);
  try { const result = await api<{ reused: boolean }>('runs', 'POST', { targetIds: supported, tier }); await reload(); setSelectedTargets([]); setSelectionMode(null); notify((result.reused ? '已有检测任务，已显示当前进度' : `${supported.length} 个模型已提交，云端启动后同时检测；整批结束后更新结果`) + (skipped ? `；跳过 ${skipped} 个未收录模型` : '')); }
  catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
 };
 if (!session || (session.authenticated && !data)) return <div className="start-screen"><img src="/icon.svg" alt="" /><h1>Relay Desk</h1><p>{error || '正在打开你的检测面板…'}</p>{error && <button className="button" onClick={() => location.reload()}>重试</button>}</div>;
 if (!session.authenticated) return <LoginForm session={session} loggedIn={async () => { setSession(await api<Session>('session')); await reload(); }} />;
 const d = data!; const selectedFilter = filterBy === 'group' ? group : station; const filter = { kind: filterBy, value: selectedFilter };
 const endpoints = endpointsInScope(d.endpoints, filter); const targets = sortTargets(targetsInScope(d.targets, d.endpoints, filter), d.endpoints, d.runs, sortBy); const stationCount = new Set(d.endpoints.map(endpoint => endpoint.base_url)).size;
 const endpointPosition = (endpoint: Endpoint) => { const index = targets.findIndex(t => t.endpoint_id === endpoint.id); return index < 0 ? Infinity : index; };
 const stationGroups = groupByBaseUrl(endpoints).map(profiles => [...profiles].sort((a, b) => endpointPosition(a) - endpointPosition(b))).sort((a, b) => endpointPosition(a[0]) - endpointPosition(b[0]));
 const scopeName = selectedFilter === 'all' ? filterBy === 'group' ? '全部分组' : '全部中转站' : filterBy === 'group' ? d.groups.find(g => g.id === group)?.name || '当前分组' : d.endpoints.find(e => e.base_url === station)?.station_name || '当前中转站';
 const checked = selectedTargets.filter(id => targets.some(t => t.id === id));
 const selectTarget = (id: string, selected: boolean) => setSelectedTargets(current => selected ? [...new Set([...current, id])] : current.filter(value => value !== id));
 const selection = <BatchSelectionBar targets={targets} selected={checked} selecting={selectionMode} busy={busy} enable={setSelectionMode} change={setSelectedTargets} start={() => start(checked)} edit={() => setDialog({ kind: 'batch-target', targetIds: [...checked] })} savePreset={() => setDialog({ kind: 'preset', targetIds: [...checked] })} mailEnabled={d.mail.enabled && d.mail.notify_manual} />;
 const latest = (id: string, finished = false) => { const t = d.targets.find(t => t.id === id); return t ? latestTargetRun(t, d.endpoints, d.runs, finished) : undefined; };
 const matched = d.targets.filter(t => { const r = latest(t.id, true); return r?.status === 'completed' && r.report?.fingerprint?.verdict === 'match'; }).length;
 const attention = d.targets.filter(t => { const r = latest(t.id, true); return r && (r.status !== 'completed' || r.report?.fingerprint?.verdict !== 'match'); }).length;
 const active = d.runs.filter(isActive).length;
 const header = PAGE_INFO[page];
 return <div className="app-shell">
  <aside className="sidebar"><a href="/" className="brand"><img src="/icon.svg" alt="" /><span>Relay Desk<small>私人模型检测</small></span></a><div className="workspace-label">工作空间 <span>PERSONAL</span></div><nav aria-label="主导航">{(Object.keys(PAGE_INFO) as Page[]).map(key => { const Icon = PAGE_INFO[key].icon; return <button key={key} className={`nav-item ${page === key ? 'selected' : ''}`} onClick={() => setPage(key)}><Icon size={19} /><span>{PAGE_INFO[key].name}</span>{key === 'overview' && d.targets.length > 0 && <small>{d.targets.length}</small>}</button>; })}</nav><div className="sidebar-bottom"><div className="private-label"><ShieldCheck size={17} /><span>私人空间<small>凭据与报告仅你可见</small></span></div><div className="user-label"><span className="avatar">{session.local ? 'L' : session.login?.slice(0, 1).toUpperCase()}</span><span>{session.login}<small>{session.local ? '本地工作空间' : '私人账号'}</small></span>{!session.local && <button className="icon-button" aria-label="退出登录" onClick={async () => { await api('auth/logout', 'POST', {}); location.reload(); }}><ArrowUpRight size={16} /></button>}</div></div></aside>
  <main className="main"><div className="topbar"><span><LockKeyhole size={13} />私人空间<span className="slash">/</span>{header.name}</span><span className="connection"><span className="status-dot" />{active ? `${active} 个任务进行中` : '配置已同步'}</span></div><div className="content">
   <header className="page-head"><div><span className="eyebrow">{page === 'overview' ? 'MODEL FINGERPRINT' : page === 'reports' ? 'EVIDENCE & HISTORY' : 'YOUR WORKSPACE'}</span><h1>{header.name}</h1><p>{header.description}</p></div><div className="head-actions">{['overview', 'stations'].includes(page) && <button className="button primary all-detect" disabled={busy || !targets.length} title={`检测${scopeName}的 ${targets.length} 个模型`} onClick={() => start(targets.map(t => t.id))}><Play size={17} />{busy ? '提交中…' : '一键全部检测'}</button>}{['overview', 'stations'].includes(page) && <button className="button" onClick={() => setDialog({ kind: 'endpoint' })}><Plus size={18} />添加站点</button>}{['overview', 'stations'].includes(page) && <span className="batch-scope">检测范围：{scopeName} · {targets.length} 个模型</span>}{page === 'reports' && <button className="button" disabled={busy} onClick={() => reload().then(() => notify('报告已刷新')).catch(e => notify(e.message, true))}><RefreshCw size={17} />刷新</button>}</div></header>
   {error && <div className="banner error-banner">{error}</div>}
   {d.local && <div className="banner local-banner"><LockKeyhole size={15} /><span>{d.preview_only ? '本地界面预览 · 使用示例数据和演示进度，不会发起检测或发送邮件。' : <>本地预览 · 配置保存在这台电脑。{!d.execution_ready && '原检测器尚未安装，联网后即可接入测试。'}</>}</span></div>}
   <ActiveProgress data={d} />
   {page === 'overview' && <><section className="stats-grid" aria-label="检测摘要"><div className="stat"><span>检测目标<Server size={17} /></span><strong>{d.targets.length.toString().padStart(2, '0')}<small>个模型</small></strong><p>{stationCount} 家中转站 · {d.groups.length} 个分组</p></div><div className="stat"><span>支持申报模型<ShieldCheck size={17} /></span><strong>{matched.toString().padStart(2, '0')}<small>个目标</small></strong><p>以最近一次完成的检测为准</p></div><div className="stat"><span>需要查看<CircleHelp size={17} /></span><strong>{attention.toString().padStart(2, '0')}<small>个目标</small></strong><p>指纹不符、证据不足或请求失败</p></div><div className="stat tinted"><span>自动监测<Clock3 size={17} /></span><strong>{d.schedules.filter(s => s.enabled).length.toString().padStart(2, '0')}<small>个计划</small></strong><button onClick={() => setPage('schedules')}>管理监测计划<ArrowUpRight size={14} /></button></div></section><RunPresetList data={d} busy={busy} create={() => setDialog({ kind: 'preset' })} edit={value => setDialog({ kind: 'preset', value })} remove={value => setDialog({ kind: 'delete-preset', value })} start={ids => start(ids)} /><div className="section-head"><div><h2>我的检测目标<span>{targets.length}</span></h2></div>{selectedFilter !== 'all' ? <button className="button small" disabled={busy || !targets.length} onClick={() => start(targets.map(t => t.id))}><Play size={15} />{filterBy === 'group' ? '检测本组' : '检测本站'}</button> : <span className="muted">按各模型的默认档位检测</span>}</div><TargetFilters data={d} mode={filterBy} changeMode={setFilterBy} selected={selectedFilter} set={filterBy === 'group' ? setGroup : setStation} /><TargetSortControl value={sortBy} change={changeSort} />{selection}
    {!targets.length ? <Empty title={d.endpoints.length ? '添加一个检测模型' : '从你的第一个站点开始'} description={d.endpoints.length ? '选择站点与申报模型，保存后就能一键检测。' : '填写 API 地址和 Key，保存后即可在这里查看模型指纹。'}><button className="button primary" onClick={() => setDialog(d.endpoints.length ? { kind: 'target', endpoint: endpoints[0]?.id || d.endpoints[0].id } : { kind: 'endpoint' })}><Plus size={17} />{d.endpoints.length ? '添加模型' : '添加站点'}</button><div className="empty-steps"><span><i>1</i>保存站点</span><ChevronRight size={14} /><span><i>2</i>选择模型</span><ChevronRight size={14} /><span><i>3</i>开始检测</span></div></Empty> : <div className="target-grid">{targets.map(t => { const endpoint = d.endpoints.find(e => e.id === t.endpoint_id)!; return <TargetCard key={t.id} selecting={!!selectionMode} editingSelection={selectionMode === 'edit'} selected={checked.includes(t.id)} select={selected => selectTarget(t.id, selected)} target={t} endpoint={endpoint} groupName={d.groups.find(g => g.id === endpoint.group_id)?.name || '默认分组'} current={latest(t.id)} previous={latest(t.id, true)} schedule={d.schedules.find(s => s.target_id === t.id)} busy={busy} start={() => start([t.id])} report={r => setDialog({ kind: 'report', value: r })} edit={() => setDialog({ kind: 'target', value: t })} monitor={() => setDialog({ kind: 'schedule', value: t })} addModel={() => setDialog({ kind: 'target', endpoint: t.endpoint_id })} editStation={() => setDialog({ kind: 'station', value: endpoint })} editKey={() => setDialog({ kind: 'endpoint', value: endpoint })} addKey={() => setDialog({ kind: 'endpoint', sameAs: endpoint })} />; })}</div>}<div className="evidence-note"><CircleHelp size={17} /><p>匹配度反映行为指纹证据，不是身份概率。查看报告时请结合判定线、有效样本与基准版本。</p></div></>}
   {page === 'stations' && <><div className="workspace-structure"><div><span><Server size={15} />中转站（URL）</span><ChevronRight size={14} /><span><LockKeyhole size={15} />Key 配置</span><ChevronRight size={14} /><span><Activity size={15} />检测模型</span></div><p><Folder size={14} />分组是分类标签，可归类不同中转站的 Key 和模型。</p></div><TargetFilters data={d} mode={filterBy} changeMode={setFilterBy} selected={selectedFilter} set={filterBy === 'group' ? setGroup : setStation} management={{ add: () => setDialog({ kind: 'group' }), manage: () => setDialog({ kind: 'groups' }), editGroup: g => setDialog({ kind: 'group', value: g }), editStation: profile => setDialog({ kind: 'station', value: profile }) }} /><TargetSortControl value={sortBy} change={changeSort} />{selection}{!endpoints.length ? <Empty icon={Server} title="保存你的中转站" description="连接只需填写一次，Key 保存后不会显示完整内容。"><button className="button primary" onClick={() => setDialog({ kind: 'endpoint' })}><Plus size={17} />添加站点</button></Empty> : <div className="station-list">{stationGroups.map(profiles => <StationCard key={profiles[0].base_url} selecting={!!selectionMode} editingSelection={selectionMode === 'edit'} selected={checked} select={selectTarget} profiles={profiles} data={d} targets={targets} latest={latest} editStation={profile => setDialog({ kind: 'station', value: profile })} edit={profile => setDialog({ kind: 'endpoint', value: profile })} addKey={profile => setDialog({ kind: 'endpoint', sameAs: profile })} addModel={profile => setDialog({ kind: 'target', endpoint: profile.id })} editTarget={target => setDialog({ kind: 'target', value: target })} />)}</div>}</>}
   {page === 'reports' && <><div className="filter-row"><label className="select-label">检测目标<select value={reportTarget} onChange={e => setReportTarget(e.target.value)}><option value="all">全部目标</option>{d.targets.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label><span className="muted">时间均为北京时间</span></div>{reportTarget !== 'all' && <HistoryChart runs={d.runs.filter(r => r.target_id === reportTarget && r.status === 'completed' && r.report?.fingerprint && r.report.fingerprint.valid_samples > 0)} />}<div className="report-list">{!d.runs.length ? <Empty icon={FileText} title="报告会保存在这里" description="开始一次检测后，可以在这里查看进度、详细证据和历史结果。" /> : d.runs.filter(r => reportTarget === 'all' || r.target_id === reportTarget).map(r => <button key={r.id} className="report-row" onClick={() => setDialog({ kind: 'report', value: r })}><span className={`report-symbol ${verdictClass(r)}`}><FileText size={21} /></span><span className="report-title"><strong>{r.snapshot.target_name}</strong><small>中转站：{snapshotConnection(r.snapshot).stationName} · Key：{snapshotConnection(r.snapshot).keyName} · 分组：{r.snapshot.group_name} · {TIER_LABEL[r.snapshot.tier]} · {r.source === 'scheduled' ? '自动监测' : '手动检测'}</small></span><Badge run={r} /><time>{date(r.ended_at || r.created_at)}</time><ChevronRight size={17} /></button>)}</div></>}
   {page === 'schedules' && <><div className="monitor-info"><Clock3 size={23} /><div><h3>需要时开启，随时暂停</h3><p>默认每 6 小时使用快速档。频率可自选，保存前会显示请求预算。</p></div></div>{!d.targets.length ? <Empty icon={Clock3} title="先添加一个检测目标" description="保存站点和模型后，就能为每个目标单独设置监测。"><button className="button" onClick={() => setPage('stations')}>管理站点<ArrowUpRight size={16} /></button></Empty> : <div className="schedule-list">{d.targets.map(t => { const endpoint = d.endpoints.find(e => e.id === t.endpoint_id); const s = d.schedules.find(v => v.target_id === t.id); return <section key={t.id} className="schedule-card"><div><span className="eyebrow">检测目标</span><h3>{t.name}</h3><ConnectionContext compact station={endpoint?.station_name || '—'} keyName={endpoint?.name || '—'} group={d.groups.find(g => g.id === endpoint?.group_id)?.name || '默认分组'} /><p>{s?.kind === 'daily' ? `每天 ${s.daily_time}` : `每 ${s?.interval_minutes || 360} 分钟`} · {TIER_LABEL[s?.tier || 'low']}档</p>{s?.enabled && <small>下次计划：{date(s.next_due)}</small>}{s?.last_error && <small className="error-text">{s.last_error}</small>}</div><div className="schedule-actions"><label className="switch-label"><input type="checkbox" role="switch" checked={!!s?.enabled} disabled={busy} aria-label={`${t.name} 定时监测`} onChange={e => save(`schedules/${t.id}`, 'PUT', { ...s, enabled: e.target.checked })} /><span className="switch" /><span>{s?.enabled ? '已开启' : '已关闭'}</span></label><button className="button small" onClick={() => setDialog({ kind: 'schedule', value: t })}>调整计划<SlidersHorizontal size={14} /></button></div></section>; })}</div>}</>}
   {page === 'settings' && <SettingsView data={d} busy={busy} save={save} account={session.local ? '' : session.login || ''} notify={notify} reload={reload} />}
   <footer className="footer"><span>Relay Desk <span>·</span> 你的私人检测工作台</span><a href="https://github.com/chen-006/meow-llm-detector" target="_blank" rel="noreferrer">内核作者 chen-006 · meow 4.5.4<ArrowUpRight size={13} /></a></footer>
  </div></main>
  <nav className="mobile-nav" aria-label="移动导航">{(Object.keys(PAGE_INFO) as Page[]).map(key => { const Icon = PAGE_INFO[key].icon; return <button key={key} className={page === key ? 'selected' : ''} onClick={() => setPage(key)}><Icon size={21} /><span>{{ overview: '总览', stations: '站点', reports: '报告', schedules: '监测', settings: '设置' }[key]}</span></button>; })}</nav>
  {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={18} /> : <Check size={18} />}{toast.text}<button onClick={() => setToast(null)} aria-label="关闭提示"><X size={16} /></button></div>}
  {dialog?.kind === 'preset' && <Dialog title={dialog.value ? '编辑常用检测组合' : '新建常用检测组合'} wide close={() => setDialog(null)}><RunPresetForm data={d} value={dialog.value} initialTargetIds={dialog.targetIds} busy={busy} save={save} /></Dialog>}
  {dialog?.kind === 'delete-preset' && <Dialog title="删除常用检测组合" close={() => setDialog(null)}><div className="form"><p>删除「{dialog.value.name}」后，这个一键检测入口会被移除。</p><p className="form-help">组合内的模型配置、Key、监测计划和历史报告都会保留。</p><div className="form-actions"><button className="button" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="button danger" disabled={busy} onClick={() => save('run-presets/' + encodeURIComponent(dialog.value.id), 'DELETE', {})}>{busy ? '删除中…' : '删除组合'}</button></div></div></Dialog>}
  {dialog?.kind === 'batch-target' && <Dialog title={`批量编辑 ${dialog.targetIds.length} 个模型`} wide close={() => setDialog(null)}><BatchTargetForm data={d} targetIds={dialog.targetIds} busy={busy} save={save} /></Dialog>}
  {dialog?.kind === 'station' && <Dialog title="编辑中转站" close={() => setDialog(null)}><StationForm data={d} value={dialog.value} busy={busy} save={save} /></Dialog>}
  {dialog?.kind === 'endpoint' && <Dialog title={dialog.value ? '编辑 Key 配置' : dialog.sameAs ? '为同一中转站添加新 Key' : '添加中转站'} close={() => setDialog(null)}><EndpointForm key={dialog.value?.id || dialog.sameAs?.id || 'new'} data={d} value={dialog.value} sameAs={dialog.sameAs} busy={busy} save={save} createGroup={createGroup} editStation={profile => setDialog({ kind: 'station', value: profile })} /></Dialog>}
  {dialog?.kind === 'target' && <Dialog title={dialog.value ? '编辑检测模型' : '添加检测模型'} wide close={() => setDialog(null)}><TargetForm data={d} value={dialog.value} endpoint={dialog.endpoint} busy={busy} save={save} notify={notify} createGroup={createGroup} /></Dialog>}
  {dialog?.kind === 'group' && <Dialog title={dialog.value ? '编辑分组' : '新建分组'} close={() => setDialog(null)}><form className="form" onSubmit={e => { e.preventDefault(); save('groups', 'POST', { id: dialog.value?.id, name: new FormData(e.currentTarget).get('name') }); }}><Field label="分组名称"><input name="name" defaultValue={dialog.value?.name} placeholder="例如：日常使用、备用站点" required maxLength={64} autoFocus /></Field><p className="form-help">修改名称会同步更新站点的所属分组，检测报告保持原样。</p><div className="form-actions">{dialog.value && dialog.value.id !== 'default' && <button type="button" className="button danger" onClick={() => setDialog({ kind: 'delete-group', value: dialog.value! })}><Trash2 size={15} />删除分组</button>}<button className="button primary" disabled={busy}>保存分组</button></div></form></Dialog>}
  {dialog?.kind === 'groups' && <Dialog title="管理分组" close={() => setDialog(null)}><div className="group-manager">{d.groups.map(g => <div className="group-manager-row" key={g.id}><div><strong>{g.name}</strong><small>{d.endpoints.filter(e => e.group_id === g.id).length} 个 Key 配置 · {d.targets.filter(t => d.endpoints.find(e => e.id === t.endpoint_id)?.group_id === g.id).length} 个模型{g.id === 'default' && ' · 默认承接分组'}</small></div><button className="button small" onClick={() => setDialog({ kind: 'group', value: g })}><Pencil size={14} />编辑</button>{g.id !== 'default' && <button className="icon-button danger-text" aria-label={`删除分组 ${g.name}`} onClick={() => setDialog({ kind: 'delete-group', value: g })}><Trash2 size={17} /></button>}</div>)}<p className="form-help">删除分组只移除这个分类，站点、模型和报告都会保留。</p><button className="button" onClick={() => setDialog({ kind: 'group' })}><Plus size={16} />新建分组</button></div></Dialog>}
  {dialog?.kind === 'delete-group' && <Dialog title="删除分组" close={() => setDialog(null)}><div className="form"><p>删除「{dialog.value.name}」后，其中的 {d.endpoints.filter(e => e.group_id === dialog.value.id).length} 个 Key 配置会移到「{d.groups.find(g => g.id === 'default')?.name || '默认分组'}」。</p><div className="note"><ShieldCheck size={17} />所有模型配置、监测计划、API Key 和历史报告都会保留。</div><div className="form-actions"><button className="button" onClick={() => setDialog({ kind: 'groups' })}>取消</button><button className="button danger" disabled={busy} onClick={() => save('groups/' + encodeURIComponent(dialog.value.id), 'DELETE', {})}>{busy ? '删除中…' : '删除分组并保留站点'}</button></div></div></Dialog>}
  {dialog?.kind === 'schedule' && <Dialog title={`监测计划 · ${dialog.value.name}`} close={() => setDialog(null)}><ScheduleForm target={dialog.value} value={d.schedules.find(s => s.target_id === dialog.value.id)} busy={busy} save={save} /></Dialog>}
  {dialog?.kind === 'report' && <Dialog title="检测报告" close={() => setDialog(null)} wide><ReportView run={d.runs.find(r => r.id === dialog.value.id) || dialog.value} /></Dialog>}
 </div>;
}
function groupByBaseUrl(endpoints: Endpoint[]) {
 const groups = new Map<string, Endpoint[]>();
 for (const endpoint of endpoints) groups.set(endpoint.base_url, [...(groups.get(endpoint.base_url) || []), endpoint]);
 return [...groups.values()];
}
type FilterManagement = { add: () => void; manage: () => void; editGroup: (group: Group) => void; editStation: (endpoint: Endpoint) => void };
function TargetFilters({ data, mode, changeMode, selected, set, management }: { data: PanelData; mode: 'group' | 'station'; changeMode: (mode: 'group' | 'station') => void; selected: string; set: (s: string) => void; management?: FilterManagement }) {
 const stations = groupByBaseUrl(data.endpoints).map(profiles => profiles[0]);
 return <div className="target-filters">
  <div className="scope-mode-toggle" role="group" aria-label="检测目标筛选方式"><button className={mode === 'group' ? 'selected' : ''} onClick={() => changeMode('group')}><Folder size={15} />按分组</button><button className={mode === 'station' ? 'selected' : ''} onClick={() => changeMode('station')}><Server size={15} />按中转站</button></div>
  <div className="group-toolbar"><div className="group-filters"><button className={selected === 'all' ? 'active' : ''} onClick={() => set('all')}><Layers3 size={14} />全部<span>{data.targets.length}</span></button>
   {mode === 'group' ? data.groups.map(g => <div className={`group-chip ${management ? 'editable' : ''} ${selected === g.id ? 'active' : ''}`} key={g.id}><button onClick={() => set(g.id)}>{g.name}<span>{targetsInScope(data.targets, data.endpoints, { kind: 'group', value: g.id }).length}</span></button>{management && <button className="group-edit" aria-label={`编辑分组 ${g.name}`} title={`编辑分组 ${g.name}`} onClick={() => management.editGroup(g)}><Pencil size={13} /></button>}</div>) : stations.map(profile => <div className={`group-chip ${management ? 'editable' : ''} ${selected === profile.base_url ? 'active' : ''}`} key={profile.base_url}><button title={profile.base_url} onClick={() => set(profile.base_url)}>{profile.station_name}<span>{targetsInScope(data.targets, data.endpoints, { kind: 'station', value: profile.base_url }).length}</span></button>{management && <button className="group-edit" aria-label={`编辑中转站 ${profile.station_name}`} title={`编辑中转站 ${profile.station_name}`} onClick={() => management.editStation(profile)}><Pencil size={13} /></button>}</div>)}
  </div>{management && mode === 'group' && <div className="group-controls"><button className="button small" onClick={management.add}><Plus size={14} />新建分组</button><button className="button small" onClick={management.manage}><SlidersHorizontal size={14} />管理分组</button></div>}</div>
  <p className="scope-helper">当前按<strong>{mode === 'group' ? '分组' : '中转站'}</strong>筛选检测模型。</p>
 </div>;
}
function TargetSortControl({ value, change }: { value: TargetSort; change: (value: TargetSort) => void }) {
 return <div className="target-sort-row"><label className="target-sort"><SlidersHorizontal size={15} /><span>排序方式</span><select value={value} onChange={e => { if (isTargetSort(e.target.value)) change(e.target.value); }}>{Object.entries(TARGET_SORTS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label><p>{TARGET_SORTS[value].hint}</p></div>;
}
function ActiveProgress({ data }: { data: PanelData }) {
 const progress = detectionOverview(data);
 if (!progress) return null;
 const mail = detectionMailState(data, progress);
 return <section className="active-progress" aria-label="全部检测进度">
  <div className="active-progress-head"><div><strong>{progress.active ? '全部进行中的检测' : '最近一批检测已结束'}</strong><span>共 {progress.total} 个目标 · 已结束 {progress.finished} · 检测中 {progress.running} · 排队中 {progress.queued}{progress.failed > 0 && ` · ${progress.failed} 个失败或超时`}</span></div><b>{progress.percent}%</b></div>
  <div className="active-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={`整批检测已完成 ${progress.percent}%`}><span style={{ width: `${progress.percent}%` }} /></div>
  <div className={`progress-mail-status ${mail.state}`}><Mail size={14} /><strong>{mail.label}</strong><span>{mail.detail}</span></div>
  <p>进度每隔几秒更新；失败和超时也计入已结束目标。此进度与模型匹配度分别计算。</p>
 </section>;
}
function TargetCheckbox({ target, selected, change, editing = false }: { target: Target; selected: boolean; editing?: boolean; change: (value: boolean) => void }) {
 const supported = BASELINES[target.protocol].models.includes(target.claimed_model);
 return <input className="target-checkbox" type="checkbox" aria-label={`${editing ? '选择编辑' : '选择检测'} ${target.name}`} title={supported || editing ? `选择 ${target.name}` : '暂无对应基准，可进入批量编辑修改模型'} checked={selected} disabled={!supported && !editing} onChange={event => change(event.target.checked)} />;
}
function BatchSelectionBar({ targets, selected, selecting, busy, enable, change, start, edit, savePreset, mailEnabled }: { targets: Target[]; selected: string[]; selecting: SelectionMode; busy: boolean; enable: (value: SelectionMode) => void; change: (value: string[]) => void; start: () => void; edit: () => void; savePreset: () => void; mailEnabled: boolean }) {
 const eligible = targets.filter(target => BASELINES[target.protocol].models.includes(target.claimed_model));
 const chosen = targets.filter(target => selected.includes(target.id));
 const checked = eligible.filter(target => selected.includes(target.id));
 const requests = checked.reduce((sum, target) => sum + plannedRequests(target.protocol, target.tier).logical, 0);
 return <section className={`batch-selection ${selecting ? 'selecting' : ''}`} aria-label="勾选批量检测">
  {!selecting ? <div className="batch-selection-actions"><button className="button small" disabled={!eligible.length || busy} onClick={() => enable('detect')}><Check size={15} />勾选批量检测</button><button className="button small" disabled={!targets.length || busy} onClick={() => enable('edit')}><Pencil size={15} />批量编辑</button></div> : <>
   <div className="batch-selection-actions"><button className="button small" onClick={() => change((selecting === 'edit' ? targets : eligible).map(target => target.id))}>全选当前范围</button><button className="button small" disabled={!selected.length} onClick={() => change([])}>清空</button><strong>已选 {chosen.length} 个模型</strong><button className={`button ${selecting === 'edit' ? 'primary' : ''} small`} disabled={busy || !chosen.length} onClick={edit}><Pencil size={15} />{`编辑所选（${chosen.length}）`}</button><button className={`button ${selecting === 'detect' ? 'primary' : ''} small`} disabled={busy || !checked.length} onClick={start}><Play size={15} />{busy ? '提交中…' : `检测所选（${checked.length}）`}</button>{selecting === 'detect' && <button className="button small" disabled={busy || !chosen.length} onClick={savePreset}><Plus size={15} />保存为常用组合</button>}<button className="icon-button" aria-label="退出勾选" onClick={() => { enable(null); change([]); }}><X size={17} /></button></div>
   <p>{selecting === 'edit' ? '先勾选要更新的模型，再点击编辑所选；保存前可预览变化，保存不会自动发起检测。' : <>按各模型的默认档位，预计 {requests} 次首轮请求，重试另计。{mailEnabled ? '全部结束后发送一封汇总邮件。' : '整批结果保存在面板，手动邮件通知已关闭。'}已有检测复用进度。</>}{selecting === 'edit' && chosen.length !== checked.length && `其中 ${chosen.length - checked.length} 个模型暂无对应基准，可编辑修正，检测时会跳过。`}</p>
  </>}
 </section>;
}
function StationCard({ selecting, editingSelection, selected, select, profiles, data, targets, latest, editStation, edit, addKey, addModel, editTarget }: { selecting: boolean; editingSelection: boolean; selected: string[]; select: (id: string, value: boolean) => void; profiles: Endpoint[]; data: PanelData; targets: Target[]; latest: (id: string) => Run | undefined; editStation: (endpoint: Endpoint) => void; edit: (endpoint: Endpoint) => void; addKey: (endpoint: Endpoint) => void; addModel: (endpoint: Endpoint) => void; editTarget: (target: Target) => void }) {
 const primary = profiles[0];
 const groupName = (endpoint: Endpoint) => data.groups.find(g => g.id === endpoint.group_id)?.name || '默认分组';
 return <section className="station">
  <div className="station-header"><div className="station-title"><span className="station-icon"><Server size={22} /></span><div><span className="station-kicker">中转站</span><h2>{primary.station_name}</h2><p>{primary.base_url}</p>{profiles.length > 1 && <small className="same-url-label">同一 URL · {profiles.length} 个 Key 配置</small>}</div></div><div className="station-header-actions"><button className="button small" onClick={() => editStation(primary)}><Pencil size={15} />编辑中转站</button><button className="button small" onClick={() => addKey(primary)}><Plus size={15} />添加同站 Key</button></div></div>
  <div className="station-meta"><span><Folder size={13} />所属分组：{profiles.length === 1 ? groupName(primary) : `${new Set(profiles.map(profile => profile.group_id)).size} 个`}</span><span><LockKeyhole size={13} />{profiles.length} 个独立 Key，分别加密保存</span></div>
  <div className="same-url-profiles">{profiles.map(profile => <div className="station-profile" key={profile.id}>
   <div className="station-profile-head"><div><span className="profile-kicker">Key 配置</span><strong>{profile.name}</strong><small><Folder size={12} />所属分组：{groupName(profile)} · <LockKeyhole size={12} />Key 已保存</small></div><div className="station-profile-actions"><button className="button small" onClick={() => edit(profile)}><SlidersHorizontal size={14} />编辑 Key 配置</button></div></div>
   <div className="station-targets"><div className="station-targets-label">检测模型</div>{targets.filter(target => target.endpoint_id === profile.id).map(target => <div key={target.id} className={selected.includes(target.id) ? 'selected-target-row' : ''}>{selecting && <TargetCheckbox editing={editingSelection} target={target} selected={selected.includes(target.id)} change={value => select(target.id, value)} />}<span className={`model-avatar ${target.protocol.includes('claude') ? 'claude' : ''}`}>{target.protocol.includes('claude') ? 'C' : 'G'}</span><span className="station-model"><strong>{target.name}</strong><small>{target.request_model} · {PROTOCOL_LABEL[target.protocol]}</small></span><Badge run={latest(target.id)} /><button className="button small model-edit" aria-label={`编辑模型 ${target.name}`} onClick={() => editTarget(target)}><Pencil size={14} />编辑模型</button></div>)}</div>
   <button className="add-model" onClick={() => addModel(profile)}><Plus size={16} />添加同站模型<span>沿用此 Key</span></button>
  </div>)}</div>
  <button className="add-model station-add-key" onClick={() => addKey(primary)}><Plus size={16} />为这个 URL 添加另一条 Key<span>可选择不同分组</span></button>
 </section>;
}
function TargetCard({ selecting, editingSelection, selected, select, target: t, endpoint, groupName, current, previous, schedule, busy, start, report, edit, monitor, addModel, editStation, editKey, addKey }: { selecting: boolean; editingSelection: boolean; selected: boolean; select: (value: boolean) => void; target: Target; endpoint: Endpoint; groupName: string; current?: Run; previous?: Run; schedule?: Schedule; busy: boolean; start: () => void; report: (r: Run) => void; edit: () => void; monitor: () => void; addModel: () => void; editStation: () => void; editKey: () => void; addKey: () => void }) {
 const primaryIssue = reportIssues(previous?.report, previous?.status, previous?.error)[0];
 const fingerprint = previous?.report?.fingerprint && previous.report.fingerprint.valid_samples > 0 ? previous.report.fingerprint : undefined; const score = fingerprint?.matches?.[t.claimed_model]; const threshold = fingerprint?.thresholds?.[t.claimed_model]; const supported = BASELINES[t.protocol].models.includes(t.claimed_model);
 return <article className={`target-card ${selected ? 'selected-target' : ''}`}><div className="target-top">{selecting && <TargetCheckbox editing={editingSelection} target={t} selected={selected} change={select} />}<span className={`model-avatar ${t.protocol.includes('claude') ? 'claude' : ''}`}>{t.protocol.includes('claude') ? 'C' : 'G'}</span><div className="target-heading"><small>检测目标</small><h3>{t.name}</h3></div><button className="button small model-edit" onClick={edit} aria-label={`编辑模型 ${t.name}`}><Pencil size={14} />编辑模型</button></div><ConnectionContext station={endpoint.station_name} keyName={endpoint.name} group={groupName} /><div className="target-result"><Badge run={current && isActive(current) ? current : previous} />{!supported && <span className="unsupported">暂无对应基准</span>}<div className="score"><strong>{score !== undefined ? (score * 100).toFixed(1) : '—'}{score !== undefined && <small>%</small>}</strong><span>申报模型匹配度</span></div><div className="match-track"><span className={verdictClass(previous)} style={{ width: `${(score || 0) * 100}%` }} />{threshold !== undefined && <i style={{ left: `${threshold * 100}%` }} title={`判定线 ${(threshold * 100).toFixed(1)}%`} />}</div><div className="result-meta"><span>{threshold !== undefined ? `判定线 ${(threshold * 100).toFixed(1)}%` : '检测后显示判定线'}</span><span>{fingerprint ? `${fingerprint.valid_samples}/${fingerprint.planned_samples} 有效样本` : '等待首份报告'}</span></div>{primaryIssue && <button className="card-error-preview" onClick={() => previous && report(previous)}><CircleHelp size={15} /><span><strong>{primaryIssue.title}</strong>{primaryIssue.summary}</span><ChevronRight size={14} /></button>}</div><div className="target-detail"><div><span>请求模型</span><code title={t.request_model}>{t.request_model}</code></div><div><span>最近检测</span><span title={date(previous?.ended_at || null)}>{previous?.ended_at ? date(previous.ended_at) : '尚未检测'}</span></div></div><div className="target-actions"><button className="button primary" disabled={busy || !supported} onClick={() => current && isActive(current) ? report(current) : start()}>{current && isActive(current) ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}{current && isActive(current) ? '查看当前进度' : '立即检测'}</button><button className="button" disabled={!current} onClick={() => current && report(current)}>查看报告<ArrowUpRight size={14} /></button></div><button className={`monitor-link ${schedule?.enabled ? 'enabled' : ''}`} onClick={monitor}><Clock3 size={13} /><span>{schedule?.enabled ? `自动监测已开启 · ${schedule.kind === 'daily' ? `每天 ${schedule.daily_time}` : `每 ${schedule.interval_minutes} 分钟`}` : '自动监测已关闭'}</span><ChevronRight size={13} /></button><button className="target-add-model" onClick={addModel}><Plus size={14} />添加同站模型<span>沿用 URL 与 Key</span></button><div className="target-config-actions"><button onClick={editStation}><Server size={13} />编辑中转站</button><button onClick={editKey}><Pencil size={13} />编辑 Key</button><button onClick={addKey}><Plus size={13} />添加 Key</button></div></article>;
}
type SaveForm = (path: string, method: string, data: unknown) => Promise<void>;
type CreateGroup = (name: string) => Promise<string>;
function GroupPicker({ data, value, change, createGroup, hint }: { data: PanelData; value: string; change: (id: string) => void; createGroup: CreateGroup; hint?: string }) {
 const [name, setName] = useState(''); const [creating, setCreating] = useState(false); const [error, setError] = useState('');
 return <div className="group-picker">
  <Field label="所属分组" hint={hint}><select value={value} onChange={e => { change(e.target.value); setError(''); }} required>
   {data.groups.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}
   <option value="__new__">＋ 自定义新建分组</option>
  </select></Field>
  {value === '__new__' && <div className="inline-group">
   <Field label="新分组名称"><input value={name} onChange={e => setName(e.target.value)} placeholder="例如：主力站点、备用站点" maxLength={64} required /></Field>
   <button type="button" className="button small" disabled={creating || !name.trim()} onClick={async () => {
    setCreating(true); setError('');
    try { change(await createGroup(name.trim())); setName(''); }
    catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
   }}>{creating ? '创建中…' : '创建并选中'}</button>
  </div>}
  {error && <p className="form-help error-text" role="alert">{error}</p>}
 </div>;
}
function StationForm({ data, value, busy, save }: { data: PanelData; value: Endpoint; busy: boolean; save: SaveForm }) {
 const profiles = data.endpoints.filter(endpoint => endpoint.base_url === value.base_url);
 const [baseUrl, setBaseUrl] = useState(value.base_url); const [confirm, setConfirm] = useState(false);
 const changedUrl = baseUrl.trim().replace(/\/+$/, '') !== value.base_url;
 return <form className="form" onSubmit={e => { e.preventDefault(); save('stations/' + value.id, 'PUT', { name: new FormData(e.currentTarget).get('name'), base_url: baseUrl, previous_base_url: value.base_url, confirm_url_change: confirm }); }}>
  <Field label="中转站名称" hint="同一 URL 的所有分组共用这个名称；各 Key 配置的名称可单独编辑。"><input name="name" defaultValue={value.station_name} required maxLength={256} autoFocus /></Field>
  <Field label="API 地址" hint="修改后，这家中转站的所有 Key 配置和模型将使用新地址。"><input name="base_url" type="url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setConfirm(false); }} required autoComplete="off" /></Field>
  <div className="station-edit-profiles"><strong>关联的 {profiles.length} 个 Key 配置</strong>{profiles.map(profile => <div key={profile.id}><span>Key 配置：{profile.name}</span><small>所属分组：{data.groups.find(g => g.id === profile.group_id)?.name}</small></div>)}</div>
  {changedUrl && <label className="confirm-url-change"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} required /><span>确认此中转站的所有 Key 都适用于新地址，后续检测使用新地址。</span></label>}
  <p className="form-help">分组、Key、模型和监测计划会保留。已有报告和正在执行的检测仍使用当时的配置。</p>
  <div className="form-actions"><button className="button primary" disabled={busy || (changedUrl && !confirm)}>{busy ? '保存中…' : '保存中转站'}</button></div>
 </form>;
}
function EndpointForm({ data, value, sameAs, busy, save, createGroup, editStation }: { data: PanelData; value?: Endpoint; sameAs?: Endpoint; busy: boolean; save: SaveForm; createGroup: CreateGroup; editStation: (endpoint: Endpoint) => void }) {
 const [groupId, setGroupId] = useState(value?.group_id || sameAs?.group_id || 'default');
 const parent = value || sameAs;
 return <form className="form endpoint-form" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); save('endpoints', 'POST', { ...f, id: value?.id, group_id: groupId }); }}>
  <section className="configuration-section">
   <h3><span>1</span>中转站</h3><p>中转站是同一个 API 地址的服务，可以在下面保存多条 Key。</p>
   {parent ? <div className="form-station-summary"><Server size={20} /><div><strong>{parent.station_name}</strong><code>{parent.base_url}</code></div><button type="button" className="button small" onClick={() => editStation(parent)}><Pencil size={13} />编辑中转站</button><input type="hidden" name="base_url" value={parent.base_url} /><input type="hidden" name="station_name" value={parent.station_name} /></div> : <>
    <Field label="中转站名称"><input name="station_name" placeholder="例如：合聚、悠米" required maxLength={256} autoFocus /></Field>
    <Field label="API 地址" hint="填写公网 HTTPS 地址；同一地址下的 Key 配置共用这个入口。"><input name="base_url" type="url" placeholder="https://api.example.com/v1" required autoComplete="off" /></Field>
   </>}
  </section>
  <section className="configuration-section">
   <h3><span>2</span>Key 配置</h3><p>给这条凭据取一个好辨认的名称。名称和 API Key 分别保存。</p>
   <Field label="Key 配置名称" hint="这是凭据的备注名，不是中转站名称，也不是 Key 的内容。"><input name="name" defaultValue={value?.name || (sameAs ? '新 Key' : '主用 Key')} placeholder="例如：主用 Key、0.08 额度 Key" required maxLength={256} autoFocus={!!parent} /></Field>
   <Field label="API Key" hint={value ? '已保存。留空保留原 Key；填入新 Key 即可替换。' : '独立加密保存；此配置下的检测模型共用这条 Key。'}><input name="key" type="password" required={!value} placeholder={value ? '已保存 · 留空保留' : '输入 API Key'} autoComplete="new-password" maxLength={4096} /></Field>
  </section>
  <section className="configuration-section">
   <h3><span>3</span>所属分组</h3><p>分组是用于筛选的分类标签，可以把不同中转站的 Key 放在同一组。</p>
   <GroupPicker data={data} value={groupId} change={setGroupId} createGroup={createGroup} hint="这条 Key 下的所有检测模型都属于此分组。" />
  </section>
  <div className="form-actions"><span><LockKeyhole size={14} />凭据仅你可用</span><button className="button primary" disabled={busy || groupId === '__new__'}>{busy ? '保存中…' : value ? '保存 Key 配置' : '保存并添加模型'}</button></div>
 </form>;
}
function TargetForm({ data, value, endpoint, busy, save, notify, createGroup }: { data: PanelData; value?: Target; endpoint?: string; busy: boolean; save: SaveForm; notify: (s: string, error?: boolean) => void; createGroup: CreateGroup }) {
 const initialEndpoint = value?.endpoint_id || endpoint || data.endpoints[0]?.id || '';
 const [ep, setEp] = useState(initialEndpoint);
 const initialBaseUrl = data.endpoints.find(e => e.id === initialEndpoint)?.base_url || '';
 const [stationUrl, setStationUrl] = useState(initialBaseUrl);
 const [groupId, setGroupId] = useState(data.endpoints.find(e => e.id === initialEndpoint)?.group_id || 'default');
 const [protocol, setProtocol] = useState<Protocol>(value?.protocol || 'gpt');
 const [claimed, setClaimed] = useState(value?.claimed_model || '');
 const [customClaimed, setCustomClaimed] = useState(!!value && !BASELINES[value.protocol].models.includes(value.claimed_model));
 const [model, setModel] = useState(value?.request_model || '');
 const [customModel, setCustomModel] = useState(!!value && value.request_model !== value.claimed_model);
 const [tier, setTier] = useState<Tier>(value?.tier || 'medium');
 const [models, setModels] = useState<string[]>([]); const [loading, setLoading] = useState(false);
 const modelInput = useRef<HTMLInputElement>(null);
 const baseline = baselineFor(protocol, claimed); const p = plannedRequests(protocol, tier);
 const selectedEndpoint = data.endpoints.find(e => e.id === ep);
 const stationOptions = [...new Map(data.endpoints.map(item => [item.base_url, item])).values()];
 const keyOptions = data.endpoints.filter(item => item.base_url === stationUrl);
 const stationLabel = (item: Endpoint) => { if (!stationOptions.some(other => other.base_url !== item.base_url && other.station_name === item.station_name)) return item.station_name; try { return `${item.station_name} · ${new URL(item.base_url).hostname}`; } catch { return item.station_name; } };
 const options = [...new Set([...models, ...BASELINES[protocol].models.map(m => defaultRequestModel(protocol, m, selectedEndpoint?.base_url || '')), ...BASELINES[protocol].models, ...(model ? [model] : [])])];
 const changeClaimed = (next: string) => { setClaimed(next); if (!customModel && (!model || model === claimed || model === defaultRequestModel(protocol, claimed, selectedEndpoint?.base_url || ''))) setModel(defaultRequestModel(protocol, next, selectedEndpoint?.base_url || '')); };
 return <form className="form" onSubmit={e => {
  e.preventDefault(); const f = new FormData(e.currentTarget);
  save('targets', 'POST', { id: value?.id, endpoint_id: ep, group_id: groupId, name: f.get('name'), protocol, claimed_model: claimed, request_model: model, tier });
 }}>
  <Field label="目标名称"><input name="name" defaultValue={value?.name} placeholder="例如：主力 GPT、备用 Claude" required maxLength={256} autoFocus /></Field>
  <section className="connection-hierarchy" aria-label="连接归属">
   <div className="connection-hierarchy-head"><Server size={18} /><div><strong>连接归属</strong><small>先选中转站，再选这家站点下的 Key 配置，最后确认所属分组。</small></div></div>
   <div className="connection-hierarchy-grid">
    <Field label="1 · 中转站"><select value={stationUrl} onChange={e => { const nextUrl = e.target.value; const next = data.endpoints.find(item => item.base_url === nextUrl)!; setStationUrl(nextUrl); setEp(next.id); setGroupId(next.group_id || 'default'); setModels([]); }} required>{stationOptions.map(item => <option value={item.base_url} key={item.base_url}>{stationLabel(item)}</option>)}</select><small>同一 API 地址的服务入口。</small></Field>
    <Field label="2 · Key 配置"><select value={ep} onChange={e => { const next = data.endpoints.find(item => item.id === e.target.value)!; setEp(next.id); setGroupId(next.group_id || 'default'); setModels([]); }} required>{keyOptions.map(item => <option key={item.id} value={item.id}>{item.name}（分组：{data.groups.find(g => g.id === item.group_id)?.name || '默认分组'}）</option>)}</select><small>该中转站下的一条独立凭据。</small></Field>
   </div>
   <div className="selected-connection-summary"><div><Server size={14} /><span>API 地址</span><code>{selectedEndpoint?.base_url || '—'}</code></div><div><LockKeyhole size={14} /><span>凭据状态</span><strong><Check size={13} />Key 已保存</strong></div></div>
   <div className="connection-group-step"><span className="step-number">3</span><GroupPicker data={data} value={groupId} change={setGroupId} createGroup={createGroup} hint="分组是用于筛选和监测的标签；修改后，此 Key 配置下的模型会一起移动。" /></div>
  </section>
  <Field label="请求协议"><select value={protocol} onChange={e => { setProtocol(e.target.value as Protocol); setClaimed(''); setCustomClaimed(false); if (!customModel) setModel(''); setModels([]); }}>{Object.entries(PROTOCOL_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></Field>
  <Field label="希望验证的模型" hint="这里选择用于比较的官方基准；站点的模型别名填在下方。">
   <select value={customClaimed ? '__custom__' : claimed} required onChange={e => { const custom = e.target.value === '__custom__'; setCustomClaimed(custom); changeClaimed(custom ? '' : e.target.value); }}>
    <option value="" disabled>选择要验证的基准模型</option>{BASELINES[protocol].models.map(m => <option key={m} value={m}>{m}{m === 'gpt-6-sol' ? '（保留旧基准）' : ''}</option>)}<option value="__custom__">＋ 自定义添加未收录模型</option>
   </select>
  </Field>
  {customClaimed && <Field label="自定义验证模型" hint="可以保存未收录的模型；在提供对应基准前，暂不支持判定。"><input value={claimed} onChange={e => changeClaimed(e.target.value)} required maxLength={256} placeholder="填写希望验证的模型名" /></Field>}
  <div className="model-picker">
   <span className="field-title">实际请求模型名</span>
   <div className="mode-toggle" role="group" aria-label="请求模型填写方式">
    <button type="button" className={!customModel ? 'selected' : ''} onClick={() => setCustomModel(false)}>从列表选择</button>
    <button type="button" className={customModel ? 'selected' : ''} onClick={() => { setCustomModel(true); requestAnimationFrame(() => modelInput.current?.focus()); }}><Plus size={14} />自定义添加</button>
   </div>
   {customModel ? <Field label="自定义请求模型名" hint="填写此站点实际接受的模型名或别名。"><input ref={modelInput} value={model} onChange={e => setModel(e.target.value)} required placeholder={protocol.startsWith('claude') ? '例如：claude-fable-5-1 或站点别名' : '例如：gpt-6.1-sol'} maxLength={256} /></Field> : <Field label="站点请求模型"><div className="input-action"><select value={model} onChange={e => setModel(e.target.value)} required><option value="" disabled>选择模型，或点击自定义添加</option>{options.map(m => <option key={m} value={m}>{m}</option>)}</select><button type="button" className="button small" disabled={loading || !ep} onClick={async () => {
    setLoading(true);
    try { const response = await api<{ models: string[] }>('models', 'POST', { endpoint_id: ep }); setModels(response.models); notify(response.models.length ? `已获取 ${response.models.length} 个模型` : '站点没有返回模型列表，可以自定义添加'); }
    catch (e) { notify((e as Error).message, true); }
    finally { setLoading(false); }
   }}>{loading ? '获取中…' : '获取模型'}</button></div></Field>}
  </div>
  <Field label="手动检测默认档位" hint={protocol.startsWith('gpt') ? claimed === 'gpt-6-sol' ? '此模型使用保留的官方 6 Sol 旧基准，新旧基准的百分比不直接比较。' : '官方新基准推荐深度档（128 次）；快速与标准档对 6.1 Sol 和 Astra 的区分可能不稳定。' : 'Claude 使用独立官方基准；Messages 为原生协议，Chat 兼容用于支持该接口的中转站。'}><select value={tier} onChange={e => setTier(e.target.value as Tier)}>{Object.entries(TIER_LABEL).map(([v, label]) => <option key={v} value={v}>{label} · {baseline.counts[v as Tier]} 次首轮请求</option>)}</select></Field>
  <div className="note"><Zap size={16} /><span>本档位 {p.logical} 次首轮请求，包含重试最多 {p.maximum} 次。检测消耗你的 API 额度。</span></div>
  <div className="form-actions"><button className="button primary" disabled={busy || groupId === '__new__'}>{busy ? '保存中…' : '保存模型'}</button></div>
 </form>;
}
function ScheduleForm({ target, value, busy, save }: { target: Target; value?: Schedule; busy: boolean; save: (path: string, method: string, data: unknown) => Promise<void> }) {
 const [enabled, setEnabled] = useState(!!value?.enabled); const [kind, setKind] = useState(value?.kind || 'interval'); const [interval, setInterval] = useState(value?.interval_minutes || 360); const [time, setTime] = useState(value?.daily_time || '09:00'); const [tier, setTier] = useState<Tier>(value?.tier || 'low'); const [custom, setCustom] = useState(![5, 15, 30, 60, 360, 1440].includes(interval));
 const plan = plannedRequests(target.protocol, tier); const rounds = kind === 'daily' ? 1 : Math.ceil(1440 / interval);
 return <form className="form" onSubmit={e => { e.preventDefault(); save(`schedules/${target.id}`, 'PUT', { enabled, kind, interval_minutes: interval, daily_time: time, tier }); }}><label className="switch-label large-switch"><span>开启定时监测</span><input type="checkbox" role="switch" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span className="switch" /></label><Field label="监测方式"><select value={kind} onChange={e => setKind(e.target.value as 'interval' | 'daily')}><option value="interval">按时间间隔</option><option value="daily">每天固定时间</option></select></Field>{kind === 'daily' ? <Field label="检测时间（北京时间）"><input type="time" value={time} onChange={e => setTime(e.target.value)} required /></Field> : <><Field label="检测频率"><select value={custom ? 'custom' : interval} onChange={e => { if (e.target.value === 'custom') setCustom(true); else { setCustom(false); setInterval(Number(e.target.value)); } }}><option value="5">每 5 分钟</option><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每 1 小时</option><option value="360">每 6 小时</option><option value="1440">每天</option><option value="custom">自定义间隔</option></select></Field>{custom && <Field label="间隔分钟数"><input type="number" value={interval} onChange={e => setInterval(Number(e.target.value))} min={5} max={43200} required /></Field>}</>}<Field label="检测档位"><select value={tier} onChange={e => setTier(e.target.value as Tier)}>{Object.entries(TIER_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></Field><div className="estimate"><span>预计每天</span><strong>{Number.isFinite(rounds) ? rounds.toLocaleString() : '—'}<small>次检测</small></strong><p>{Number.isFinite(rounds) ? (rounds * plan.logical).toLocaleString() : '—'} 次首轮请求 · 含重试最多 {Number.isFinite(rounds) ? (rounds * plan.maximum).toLocaleString() : '—'} 次</p></div><p className="form-help">免费执行额度与 API 用量上限会限制实际可持续频率。任务重叠时合并，不堆积补测。</p><div className="form-actions"><button className="button primary" disabled={busy}>保存监测计划</button></div></form>;
}
function ErrorPreview({ run }: { run: Run }) {
 const issues = reportIssues(run.report, run.status, run.error);
 if (!issues.length) return null;
 return <section className="error-preview" aria-label="错误摘要">
  <div className="error-preview-head"><CircleHelp size={19} /><h4>错误摘要</h4><span>{issues.reduce((count, issue) => count + issue.count, 0)} 条异常记录</span></div>
  <p className="error-explanation">依据实际状态码与上游消息整理。请求失败和样本不足不判为模型不符。</p>
  {issues.map((issue, index) => <article className="error-issue" key={index}>
   <div><strong>{issue.title}</strong>{issue.httpStatus !== null && <code>HTTP {issue.httpStatus}</code>}<small>{issue.count} 条</small></div>
   <p>{issue.summary}</p><p className="error-advice"><span>建议</span>{issue.advice}</p>
   <details><summary>预览错误详情</summary><dl><dt>错误类型</dt><dd><code>{issue.code}</code></dd>{issue.stage && <><dt>发生阶段</dt><dd>{({ address_check: '连接前地址检查', detector_setup: '初始化检测器', detection: '模型检测' } as Record<string, string>)[issue.stage] || issue.stage}</dd></>}{issue.httpStatus !== null && <><dt>上游状态</dt><dd>HTTP {issue.httpStatus}</dd></>}<dt>上游或执行器消息</dt><dd><pre>{issue.detail || '上游没有提供更多消息。可在下方预览完整报告。'}</pre></dd></dl></details>
  </article>)}
 </section>;
}
function snapshotConnection(snapshot: Run['snapshot']) {
 const stationName = snapshot.station_name || snapshot.endpoint_name.split(' / ')[0];
 const keyName = snapshot.endpoint_name.startsWith(stationName + ' / ') ? snapshot.endpoint_name.slice(stationName.length + 3) : snapshot.endpoint_name;
 return { stationName, keyName };
}
function ReportView({ run }: { run: Run }) {
 const f = run.report?.fingerprint; const b = run.report?.benchmark;
 const { stationName, keyName } = snapshotConnection(run.snapshot);
 return <div className="report-detail">
  <div className="report-summary"><div><span className="eyebrow">检测目标</span><h3>{run.snapshot.target_name}</h3><p>{date(run.ended_at || run.created_at)} · {TIER_LABEL[run.snapshot.tier]}档</p></div><Badge run={run} /></div>
  <ConnectionContext compact station={stationName} keyName={keyName} group={run.snapshot.group_name} />
  {isActive(run) && <div className="note"><RefreshCw className="spin" size={16} /><span>任务正在进行。页面关闭后仍会继续，结果会自动更新。</span></div>}
  <ErrorPreview run={run} />
  <div className="report-metrics"><div><span>有效样本</span><strong>{f ? `${f.valid_samples} / ${f.planned_samples}` : '—'}</strong></div><div><span>实际请求</span><strong>{isActive(run) ? `${Number(run.report?.progress?.http_attempts || 0)} 次 · 进行中` : `${run.attempts} 次`}</strong></div><div><span>主要指向</span><strong>{f?.model || '证据不足'}</strong></div></div>
  <h4>候选模型匹配度</h4>
  {f && f.valid_samples > 0 ? <div className="candidates">{Object.entries(f.matches).sort((a, b) => b[1] - a[1]).map(([model, value]) => <div key={model}><div><span>{model === 'other_known_external' ? '其他已知模型' : model}{model === run.snapshot.claimed_model && <small>申报</small>}</span><strong>{(value * 100).toFixed(1)}%</strong></div><div className="match-track"><span style={{ width: `${value * 100}%` }} />{f.thresholds[model] !== undefined && <i style={{ left: `${f.thresholds[model] * 100}%` }} />}</div><small>判定线 {f.thresholds[model] !== undefined ? (f.thresholds[model] * 100).toFixed(1) + '%' : '未校准'}</small></div>)}</div> : <p className="muted">{f ? '没有有效样本，暂时无法比较候选模型。' : '有效回答回传后显示匹配度。'}</p>}
  <div className="report-properties"><div><span>实际请求模型</span><code>{run.snapshot.request_model}</code></div><div><span>申报模型</span><code>{run.snapshot.claimed_model}</code></div><div><span>协议</span><span>{PROTOCOL_LABEL[run.snapshot.protocol]}</span></div><div><span>基准版本</span><code>{b?.version || run.snapshot.baseline_version}</code></div><div><span>基准校验值</span><code>{b?.content_sha256 || run.snapshot.baseline_sha256}</code></div></div>
  {!!f?.reasons?.length && <div className="note">判定依据提示：{f.reasons.map(fingerprintReason).join('；')}</div>}
  <details className="report-json"><summary>预览完整报告（JSON）</summary><pre>{JSON.stringify(run.report || { status: run.status, error: run.error, attempts: run.attempts }, null, 2)}</pre></details>
  <p className="form-help">匹配度不是身份概率，不需要合计 100%。检测不符不能单独判定服务商替换模型的原因。</p>
  <div className="form-actions"><button className="button" onClick={() => exportRun(run)}><Download size={17} />导出 JSON 报告</button></div>
 </div>;
}
function HistoryChart({ runs }: { runs: Run[] }) {
 if (!runs.length) return null; const key = comparisonKey(runs[0]); const values = runs.filter(r => comparisonKey(r) === key).slice(0, 20).reverse();
 const points = values.map((r, i) => `${values.length === 1 ? 300 : 30 + (i / (values.length - 1)) * 540},${130 - (r.report?.fingerprint?.matches[r.snapshot.claimed_model] || 0) * 100}`).join(' ');
 return <section className="history-chart"><div><h3>申报模型匹配度趋势</h3><span>相同模型、协议、档位与基准 · 最近 {values.length} 次</span></div><svg viewBox="0 0 600 160" role="img" aria-label="可比较报告的申报模型匹配度趋势"><path d="M30 30H570M30 80H570M30 130H570" stroke="#e5e6df" strokeDasharray="4 5" fill="none" /><text x="0" y="33">100</text><text x="5" y="83">50</text><text x="10" y="133">0</text><polyline points={points} stroke="#568775" strokeWidth="2.5" fill="none" />{points.split(' ').map((p, i) => <circle key={i} cx={p.split(',')[0]} cy={p.split(',')[1]} r="4" fill="#568775"><title>{date(values[i].ended_at)} · {((values[i].report?.fingerprint?.matches[values[i].snapshot.claimed_model] || 0) * 100).toFixed(1)}%</title></circle>)}</svg><p className="form-help">基准更新或参数不同的报告不混入这条趋势。</p></section>;
}
function SettingsView({ data, busy, save, account, notify, reload }: { data: PanelData; busy: boolean; save: SaveForm; account: string; notify: (text: string, error?: boolean) => void; reload: () => Promise<void> }) {
 const [enabled, setEnabled] = useState(data.mail.enabled); const [mode, setMode] = useState(data.mail.mode);
 const [notifyManual, setNotifyManual] = useState(data.mail.notify_manual);
 const [mail, setMail] = useState({ host: data.mail.host, port: data.mail.port || 465, username: data.mail.username, from: data.mail.from, to: data.mail.to });
 const credentialSaved = data.mail.credential_saved && mail.host === data.mail.host && mail.port === data.mail.port && mail.username === data.mail.username;
 const updateMail = (field: keyof typeof mail, value: string | number) => setMail(current => ({ ...current, [field]: value }));
 const [testing, setTesting] = useState(false);
 const mailChanged = enabled !== data.mail.enabled || notifyManual !== data.mail.notify_manual || mode !== data.mail.mode || Object.entries(mail).some(([field, value]) => (field === 'to' ? recipientAddresses(String(value)).join(', ') : value) !== data.mail[field as keyof typeof mail]);
 const testPending = data.last_mail_test && ['pending', 'processing'].includes(data.last_mail_test.status);
 return <div className="settings-stack">
  <section className="settings-panel">
   <div className="settings-heading"><span className="station-icon"><Zap size={23} /></span><div><h2>用量上限</h2><p>达到上限时暂停新任务，历史报告仍可查看。</p></div></div>
   <div className="usage-grid"><Usage label="今日请求预算占用" value={data.usage.daily_requests} max={data.limits.daily_requests} suffix="次" /><Usage label="本月执行预算占用" value={data.usage.monthly_minutes} max={data.limits.monthly_minutes} suffix="分钟" /></div>
   <form className="form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); save('settings/limits', 'PUT', { daily_requests: Number(f.get('daily_requests')), monthly_minutes: Number(f.get('monthly_minutes')) }); }}>
    <div className="two-fields"><Field label="每日请求上限"><input type="number" name="daily_requests" defaultValue={data.limits.daily_requests} min={1} max={1000000} required /></Field><Field label="每月执行分钟上限"><input type="number" name="monthly_minutes" defaultValue={data.limits.monthly_minutes} min={15} max={100000} required /></Field></div>
    <p className="form-help">排队与运行中的任务会先预留最大预算，结束后按实际用量结算。GitHub 免费额度与账号其他任务共享，API 费用由中转站账户承担。</p><div className="form-actions"><button className="button" disabled={busy}>保存用量上限</button></div>
   </form>
  </section>
  <section className="settings-panel">
   <div className="settings-heading"><span className="station-icon"><Mail size={23} /></span><div><h2>邮件通知</h2><p>配置发件邮箱，把报告送到你指定的收件邮箱。</p></div></div>
   <div className="mail-setup"><button className="button small" onClick={() => { const address = mail.username.toLowerCase().endsWith('@qq.com') ? mail.username : account.toLowerCase().endsWith('@qq.com') ? account : ''; setMail({ host: 'smtp.qq.com', port: 465, username: address, from: address, to: mail.to || account || address }); }}><Mail size={15} />使用 QQ 邮箱配置</button><details><summary>QQ 邮箱怎么设置？</summary><ol><li>登录 QQ 邮箱，在“设置 → 账户”或“账号与安全”中找到 SMTP 服务／授权码。</li><li>按邮箱提示开启服务并生成授权码，填到下方“SMTP 授权码”。此授权码与面板登录密码独立。</li><li>填写收件邮箱，选择通知方式，开启邮件通知并保存。收件邮箱支持多个，每行一个或用逗号分隔，可以包含发件邮箱。</li></ol></details></div>
   {data.last_mail_error && <div className="note error-text">{data.last_mail_error}</div>}
   <form className="form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); save('settings/mail', 'PUT', { ...mail, password: f.get('password'), enabled, mode, notify_manual: notifyManual }); }}>
    <label className="switch-label large-switch"><span>开启邮件通知</span><input type="checkbox" role="switch" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span className="switch" /></label>
    <div className="manual-mail-setting"><label className="switch-label large-switch"><span>手动检测也发送邮件</span><input type="checkbox" role="switch" checked={notifyManual} disabled={!enabled} onChange={e => setNotifyManual(e.target.checked)} /><span className="switch" /></label><p className="form-help">开启后，单个检测结束发一封；一键或勾选批量检测等全部结束后发一封汇总。关闭后只通知自动监测结果。总开关关闭时均不发送。</p></div>
    <Field label="自动监测通知方式"><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="changes">异常与恢复时提醒</option><option value="daily">每日 09:00 汇总（北京时间）</option><option value="all">每轮自动检测结束汇总</option></select></Field>
    <div className="two-fields"><Field label="SMTP 服务器"><input value={mail.host} onChange={e => updateMail('host', e.target.value)} placeholder="QQ 邮箱：smtp.qq.com" required={enabled} /></Field><Field label="SMTP 端口" hint="QQ 邮箱使用 465，TLS 加密发送。"><input type="number" value={mail.port} onChange={e => updateMail('port', Number(e.target.value))} min={1} max={65535} required /></Field></div>
    <Field label="SMTP 登录账号" hint="填写完整的发件邮箱地址。"><input value={mail.username} onChange={e => updateMail('username', e.target.value)} placeholder="例如：123456789@qq.com" required={enabled} autoComplete="off" /></Field>
    <Field label="SMTP 授权码" hint={credentialSaved ? '已保存。留空保留；更换发件账户时重新填写授权码。' : '填写在邮箱中生成的 SMTP 授权码，不填写面板密码或 QQ 登录密码。'}><input name="password" type="password" autoComplete="new-password" required={enabled && !credentialSaved} placeholder={credentialSaved ? '已保存 · 留空保留' : '粘贴邮箱生成的授权码'} maxLength={4096} /></Field>
    <Field label="发件邮箱" hint="通常与 SMTP 登录账号相同。"><input type="email" value={mail.from} onChange={e => updateMail('from', e.target.value)} required={enabled} placeholder="sender@qq.com" /></Field><Field label="收件邮箱（可填写多个）" hint="每行一个邮箱，或用逗号、分号分隔。重复地址自动合并；可包含发件邮箱。"><textarea value={mail.to} onChange={e => updateMail('to', e.target.value)} required={enabled} rows={3} maxLength={4096} placeholder={'your@qq.com\nother@example.com'} inputMode="email" /></Field>
    <p className="form-help">未开启时不会发送邮件。授权码加密保存；报告邮件只包含结果与私人报告链接。</p><div className="form-actions"><button type="button" className="button" disabled={busy || testing || !data.mail.enabled || !credentialSaved || mailChanged || !!testPending} onClick={async () => {
     setTesting(true);
     try { const result = await api<{ status: string }>('settings/mail/test', 'POST', {}); await reload(); notify(result.status === 'sent' ? '测试邮件已交给邮箱服务器，请查看收件箱' : result.status === 'failed' || result.status === 'cancelled' ? '上一封测试邮件未发送，请稍等一分钟后重试' : '测试邮件已加入队列，发送结果会显示在下方'); }
     catch (e) { notify((e as Error).message, true); } finally { setTesting(false); }
    }}><Mail size={15} />{testing ? '提交中…' : testPending ? '测试邮件发送中…' : '发送测试邮件'}</button><button className="button primary" disabled={busy}>保存邮件设置</button></div>
   </form>
   <div className="mail-test-status" role="status">{data.last_mail_test ? <><strong>{({ pending: '测试邮件排队中', processing: '测试邮件正在发送', sent: '测试邮件已交给邮箱服务器', failed: '测试邮件发送失败', cancelled: '测试邮件已取消' } as Record<string, string>)[data.last_mail_test.status] || '等待发送结果'}</strong><p>{data.last_mail_test.error || (data.last_mail_test.status === 'sent' ? `发送至 ${data.mail.to}，请检查收件箱及垃圾邮件。` : testPending ? '云端执行，页面关闭也会继续。已有检测任务时，邮件测试会等待检测结束。' : '请先保存并开启邮件通知，再发送测试邮件。')}</p><small>{date(data.last_mail_test.sent_at || data.last_mail_test.created_at)}</small></> : <p>{mailChanged ? '请先保存邮件设置，再发送测试邮件。' : '保存授权码并开启邮件通知后，可发送一封测试邮件；不会调用模型 API。'}</p>}</div>
  </section>
  <section className="settings-panel"><div className="settings-heading"><span className="station-icon"><Layers3 size={23} /></span><div><h2>放到你的桌面</h2><p>打开就能查看最近结果，查看报告不消耗 API 额度。</p></div></div><div className="install-instructions"><div><h3>iPhone / iPad</h3><p>在 Safari 打开网站，点击分享，选择“添加到主屏幕”。</p></div><div><h3>Android / 电脑</h3><p>在浏览器菜单中选择安装应用或添加到主屏幕；电脑也可以收藏为书签。</p></div></div></section>
 </div>;
}
function Usage({ label, value, max, suffix }: { label: string; value: number; max: number; suffix: string }) { return <div className="usage"><span>{label}</span><div><strong>{value.toLocaleString()}</strong><small>/ {max.toLocaleString()} {suffix}</small></div><div className="match-track"><span style={{ width: `${Math.min(100, value / max * 100)}%` }} /></div></div>; }
