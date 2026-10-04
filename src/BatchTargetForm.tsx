import { useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CircleHelp, LockKeyhole, Save, Zap } from 'lucide-react';
import ConnectionContext from './ConnectionContext.tsx';
import { BASELINES, baselineFor, defaultRequestModel, plannedRequests, PROTOCOL_LABEL, TIER_LABEL, type PanelData, type Protocol, type Target, type Tier } from './shared.ts';

interface Props {
 data: PanelData;
 targetIds: string[];
 busy: boolean;
 save: (path: string, method: string, body: unknown) => void;
}
type RequestMode = 'keep' | 'default' | 'custom';
type Changes = Partial<Pick<Target, 'protocol' | 'claimed_model' | 'request_model' | 'tier'>>;

function EditField({ title, enabled, change, busy, children }: { title: string; enabled: boolean; change: (enabled: boolean) => void; busy: boolean; children: ReactNode }) {
 return <fieldset className={`batch-edit-field ${enabled ? 'enabled' : ''}`}>
  <legend><label><input type="checkbox" checked={enabled} disabled={busy} onChange={e => change(e.target.checked)} /><span>{title}</span></label></legend>
  {children}
  {!enabled && <p className="form-help">保持每个目标原来的设置。</p>}
 </fieldset>;
}
function PreviewValue({ title, before, after }: { title: string; before: string; after: string }) {
 return <div className={`batch-edit-value ${before !== after ? 'changed' : ''}`}><dt>{title}</dt><dd>{before === after ? <><span>{before}</span><small>保持</small></> : <><span className="batch-edit-before">{before}</span><ArrowRight size={13} aria-label="更新为" /><strong>{after || '待填写'}</strong></>}</dd></div>;
}

export default function BatchTargetForm({ data, targetIds, busy, save }: Props) {
 // The selection belongs to this dialog, independent of later filters or refreshes.
 const [selection] = useState(() => [...new Set(targetIds)]);
 const targets = selection.map(id => data.targets.find(target => target.id === id)).filter((target): target is Target => !!target);
 const first = targets[0];
 const [editProtocol, setEditProtocol] = useState(false);
 const [protocol, setProtocol] = useState<Protocol>(first?.protocol || 'gpt');
 const [editClaimed, setEditClaimed] = useState(false);
 const [claimed, setClaimed] = useState(first?.claimed_model || 'gpt-6.1-sol');
 const [customClaimed, setCustomClaimed] = useState(false);
 const [requestMode, setRequestMode] = useState<RequestMode>('keep');
 const [requestModel, setRequestModel] = useState('');
 const [editTier, setEditTier] = useState(false);
 const [tier, setTier] = useState<Tier>(first?.tier || 'medium');
 const requestModeTouched = useRef(false);
 const implicitlySyncedRequest = useRef(false);
 const effectiveProtocols = [...new Set(targets.map(target => editProtocol ? protocol : target.protocol))];
 const modelOptions = [...new Set(effectiveProtocols.flatMap(value => BASELINES[value].models))];
 const usingCustomClaimed = customClaimed || !modelOptions.includes(claimed);
 const mixedFamilies = new Set(effectiveProtocols.map(value => value.startsWith('claude') ? 'Claude' : 'GPT')).size > 1;
 const missing = selection.length - targets.length;
 const missingConnections = targets.filter(target => !data.endpoints.some(endpoint => endpoint.id === target.endpoint_id)).length;
 const changes: Changes = {};
 if (editProtocol) changes.protocol = protocol;
 if (editClaimed) changes.claimed_model = claimed.trim();
 if (requestMode === 'custom') changes.request_model = requestModel.trim();
 if (editTier) changes.tier = tier;
 const previews = targets.map(target => {
  const endpoint = data.endpoints.find(value => value.id === target.endpoint_id);
  const next = { ...target, ...changes };
  if (requestMode === 'default') next.request_model = defaultRequestModel(next.protocol, next.claimed_model, endpoint?.base_url || '');
  const supported = baselineFor(next.protocol, next.claimed_model).models.includes(next.claimed_model);
  const changed = (['protocol', 'claimed_model', 'request_model', 'tier'] as const).some(key => next[key] !== target[key]);
  return { target, next, endpoint, supported, changed, requests: plannedRequests(next.protocol, next.tier) };
 });
 const changedCount = previews.filter(preview => preview.changed).length;
 const unsupported = previews.filter(preview => !preview.supported).length;
 const supportedPreviews = previews.filter(preview => preview.supported);
 const logical = supportedPreviews.reduce((total, preview) => total + preview.requests.logical, 0);
 const maximum = supportedPreviews.reduce((total, preview) => total + preview.requests.maximum, 0);
 const invalidClaimed = editClaimed && (!claimed.trim() || claimed.trim().length > 256);
 const invalidRequest = requestMode === 'custom' && (!requestModel.trim() || requestModel.trim().length > 256);
 const invalid = !!missing || !!missingConnections || !targets.length || invalidClaimed || invalidRequest;

 return <form className="form batch-edit-form" onSubmit={event => {
  event.preventDefault();
  if (busy || invalid || !changedCount) return;
  save('targets/batch', 'POST', { targetIds: selection, changes, sync_request_model: requestMode === 'default' });
 }}>
  <div className="batch-edit-intro"><strong>编辑已勾选的 {selection.length} 个检测目标</strong><p>勾选要统一修改的项目；未勾选的项目保留各自设置。下方预览列出了本次全部目标。</p></div>
  {(missing > 0 || missingConnections > 0) && <div className="note error-text" role="alert">{missing > 0 ? `${missing} 个已选目标已被删除。` : ''}{missingConnections > 0 ? `${missingConnections} 个目标的连接配置已不存在。` : ''}请关闭此窗口，重新选择后编辑。</div>}
  <div className="two-fields batch-edit-fields">
   <EditField title="统一请求协议" enabled={editProtocol} change={setEditProtocol} busy={busy}>
    <label className="field"><span className="batch-edit-sr-only">批量请求协议</span><select aria-label="批量请求协议" value={protocol} disabled={!editProtocol || busy} onChange={event => setProtocol(event.target.value as Protocol)}>{Object.entries(PROTOCOL_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
   </EditField>
   <EditField title="统一手动检测档位" enabled={editTier} change={setEditTier} busy={busy}>
    <label className="field"><span className="batch-edit-sr-only">批量检测档位</span><select aria-label="批量检测档位" value={tier} disabled={!editTier || busy} onChange={event => setTier(event.target.value as Tier)}>{Object.entries(TIER_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    {editTier && <p className="form-help">修改手动检测的默认档位，定时监测计划沿用自己的档位。</p>}
   </EditField>
  </div>
  <EditField title="统一希望验证的模型" enabled={editClaimed} busy={busy} change={enabled => {
   setEditClaimed(enabled);
   if (!requestModeTouched.current) {
    if (enabled && requestMode === 'keep') { setRequestMode('default'); implicitlySyncedRequest.current = true; }
    else if (!enabled && implicitlySyncedRequest.current) { setRequestMode('keep'); implicitlySyncedRequest.current = false; }
   }
  }}>
   <label className="field"><span className="batch-edit-sr-only">批量希望验证的模型</span><select aria-label="批量希望验证的模型" value={usingCustomClaimed ? '__custom__' : claimed} disabled={!editClaimed || busy} onChange={event => {
    const custom = event.target.value === '__custom__';
    setCustomClaimed(custom); setClaimed(custom ? '' : event.target.value);
   }}>{modelOptions.map(model => <option value={model} key={model}>{mixedFamilies ? `${model.startsWith('claude') ? 'Claude' : 'GPT'} · ` : ''}{model}{model === 'gpt-6-sol' ? '（保留旧基准）' : ''}</option>)}<option value="__custom__">＋ 自定义未收录模型</option></select></label>
   {editClaimed && usingCustomClaimed && <label className="field"><span>自定义验证模型</span><input value={claimed} required maxLength={256} disabled={busy} placeholder="填写希望验证的模型名" onChange={event => setClaimed(event.target.value)} /></label>}
   {editClaimed && mixedFamilies && <p className="form-help batch-edit-warning"><CircleHelp size={14} />已选目标同时使用 GPT 和 Claude 协议。统一模型时请核对协议；跨模型系列的配置可能无法检测。</p>}
  </EditField>
  <label className="field"><span>实际请求模型名</span><select value={requestMode} disabled={busy} onChange={event => { requestModeTouched.current = true; implicitlySyncedRequest.current = false; setRequestMode(event.target.value as RequestMode); }}><option value="keep">保持每个目标的请求模型名</option><option value="default">跟随保存后的验证模型，按站点生成默认名称</option><option value="custom">统一填写自定义请求模型名</option></select><small>默认名称分别按每个站点生成；Claude 会使用该站点对应的模型名格式。站点有专用别名时，可以保持原值或自定义。</small></label>
  {requestMode === 'custom' && <label className="field"><span>统一自定义请求模型名</span><input value={requestModel} required maxLength={256} disabled={busy} placeholder="填写所有已选目标实际接受的模型名或别名" onChange={event => setRequestModel(event.target.value)} /></label>}
  <section className="batch-edit-preview" aria-label="批量编辑保存前预览">
   <div className="batch-edit-preview-head"><h3>保存前预览</h3><span>{changedCount} 个目标有变化</span></div>
   <div className="batch-edit-preview-list">{previews.map(({ target, next, endpoint, supported, changed, requests }) => <article className={`batch-edit-preview-card ${changed ? 'changed' : ''}`} key={target.id}>
    <header><strong>{target.name}</strong><ConnectionContext compact station={endpoint?.station_name || '连接已不存在'} keyName={endpoint?.name || '—'} group={data.groups.find(group => group.id === endpoint?.group_id)?.name || '—'} /></header>
    <dl><PreviewValue title="请求协议" before={PROTOCOL_LABEL[target.protocol]} after={PROTOCOL_LABEL[next.protocol]} /><PreviewValue title="希望验证的模型" before={target.claimed_model} after={next.claimed_model} /><PreviewValue title="实际请求模型名" before={target.request_model} after={next.request_model} /><PreviewValue title="手动默认档位" before={TIER_LABEL[target.tier]} after={TIER_LABEL[next.tier]} /></dl>
    <p className={supported ? 'batch-edit-request-count' : 'batch-edit-request-count batch-edit-warning'}>{supported ? `${requests.logical} 次首轮请求 · 含重试最多 ${requests.maximum} 次` : '暂不支持判定：当前协议没有这个模型的基准'}</p>
   </article>)}</div>
  </section>
  {unsupported > 0 && <div className="note batch-edit-warning"><CircleHelp size={16} /><span>保存后有 {unsupported} 个目标暂不支持判定。配置仍可保存，提供对应基准前无法发起检测；请核对上方模型和协议。</span></div>}
  <div className="note"><Zap size={16} /><span>按保存后的默认档位检测这 {supportedPreviews.length} 个支持判定的目标，预计共 {logical.toLocaleString()} 次首轮请求，含重试最多 {maximum.toLocaleString()} 次。此次保存不会发起检测。</span></div>
  <p className="form-help batch-edit-preserve"><LockKeyhole size={14} /><span>URL、API Key、分组和目标名称保留。修改从下一次新检测生效；排队中、检测中的任务和历史报告沿用原来的配置。</span></p>
  {(invalidClaimed || invalidRequest) && <p className="form-help error-text" role="alert">启用修改的模型名不能为空，且不能超过 256 个字符。</p>}
  <div className="form-actions"><span>仅更新上方列出的目标</span><button className="button primary" disabled={busy || invalid || !changedCount}><Save size={16} />{busy ? '保存中…' : `保存 ${changedCount} 个目标的修改`}</button></div>
 </form>;
}
