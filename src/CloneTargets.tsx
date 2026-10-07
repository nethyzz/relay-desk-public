import { useState } from 'react';
import { ArrowRight, Check, CircleHelp, CopyPlus, Search, ShieldCheck } from 'lucide-react';
import ConnectionContext from './ConnectionContext.tsx';
import ModelPicker from './ModelPicker.tsx';
import { cloneConfiguration, clonePreviews, compatibleCopy, detectionModelGroups, type CloneInput } from './target-cloning.ts';
import { PROTOCOL_LABEL, TIER_LABEL, type PanelData } from './shared.ts';

interface Props {
 data: PanelData;
 claimedModel?: string;
 initialTargetIds?: string[];
 busy: boolean;
 save: (path: string, method: string, body: unknown) => void;
}
export default function CloneTargets({ data, claimedModel, initialTargetIds = [], busy, save }: Props) {
 const [sourceData] = useState(data);
 const [operationId] = useState(() => crypto.randomUUID());
 const firstSource = sourceData.targets.find(target => initialTargetIds.includes(target.id));
 const models = detectionModelGroups(sourceData.targets).map(group => group.model);
 const initialModel = claimedModel || (firstSource ? models.find(model => model !== firstSource.claimed_model && compatibleCopy(firstSource.protocol, model)) : '') || '';
 const [claimed, setClaimed] = useState(initialModel);
 const [custom, setCustom] = useState(!!initialModel && !models.includes(initialModel));
 const [selected, setSelected] = useState(initialTargetIds);
 const [aliases, setAliases] = useState<Record<string, string>>({});
 const [search, setSearch] = useState('');
 const allPreviews = clonePreviews(sourceData, sourceData.targets.map(target => ({ source_id: target.id, ...(Object.hasOwn(aliases, target.id) ? { request_model: aliases[target.id] } : {}) })), claimed.trim());
 const previews = clonePreviews(sourceData, selected.map(source_id => ({ source_id, ...(Object.hasOwn(aliases, source_id) ? { request_model: aliases[source_id] } : {}) })), claimed.trim());
 const groups = new Map(sourceData.groups.map(group => [group.id, group.name]));
 const query = search.trim().toLocaleLowerCase();
 const visible = allPreviews.filter(preview => !query || [preview.source?.name, preview.source?.claimed_model, preview.endpoint?.station_name, preview.endpoint?.name, groups.get(preview.endpoint?.group_id || '')].some(value => value?.toLocaleLowerCase().includes(query)));
 const ready = previews.filter(preview => preview.status === 'ready');
 const existing = previews.filter(preview => preview.status === 'existing');
 const invalid = !claimed.trim() || claimed.trim().length > 256 || !previews.length || previews.some(preview => ['missing', 'incompatible'].includes(preview.status) || !preview.requestModel.trim() || preview.requestModel.length > 256);
 const stations = new Set(ready.map(preview => preview.endpoint?.base_url)).size;
 const changeModel = (value: string) => { setClaimed(value); setAliases({}); setSelected(current => current.filter(id => { const source = sourceData.targets.find(target => target.id === id); return source && compatibleCopy(source.protocol, value); })); };
 return <form className="form clone-targets-form" onSubmit={event => {
  event.preventDefault(); if (busy || invalid) return;
  const input: CloneInput = { operation_id: operationId, claimed_model: claimed.trim(), sources: previews.map(preview => ({ source_id: preview.sourceId, request_model: preview.requestModel.trim(), configuration: cloneConfiguration(preview.source!, preview.endpoint!, preview.schedule) })) };
  save('targets/clone', 'POST', input);
 }}>
  <div className="clone-intro"><CopyPlus size={21} /><div><strong>换一个模型，沿用已有测试配置</strong><p>可跨中转站、跨分组勾选来源。目标名称、URL、Key、分组、请求协议、检测档位和监测设置都沿用各自来源。</p></div></div>
  <div className="field"><span>要添加的检测模型</span><ModelPicker label="新检测模型" value={claimed} models={detectionModelGroups(sourceData.targets)} disabled={busy} placeholder="选择要添加的模型" customSelected={custom} change={value => { setCustom(false); changeModel(value); }} custom={() => { setCustom(true); changeModel(''); }} /><small>按希望验证的模型归类。不同站点的请求别名可在下方分别调整。</small></div>
  {custom && <label className="field"><span>自定义检测模型</span><input value={claimed} disabled={busy} required maxLength={256} placeholder="例如：站点支持的新模型" onChange={event => changeModel(event.target.value)} /></label>}
  <section className="clone-source-section" aria-label="选择复制来源">
   <div className="clone-source-head"><div><h3>选择已有检测配置</h3><p>只添加新目标，原目标和历史报告保留。</p></div><div><button type="button" className="button small" disabled={busy || !claimed.trim()} onClick={() => setSelected(allPreviews.filter(preview => preview.status === 'ready').map(preview => preview.sourceId))}>全选可添加配置</button><button type="button" className="button small" disabled={busy || !selected.length} onClick={() => setSelected([])}>清空</button></div></div>
   <label className="clone-search"><Search size={15} /><input value={search} disabled={busy} aria-label="搜索复制来源" placeholder="搜索中转站、Key、分组或模型" onChange={event => setSearch(event.target.value)} /></label>
   <div className="clone-source-list" role="group" aria-label="可复制的模型配置">{visible.map(preview => {
    const source = preview.source!; const checked = selected.includes(preview.sourceId);
    const available = claimed.trim() && !['missing', 'incompatible', 'duplicate'].includes(preview.status);
    return <label key={preview.sourceId} className={`clone-source-row ${checked ? 'selected' : ''} ${!available ? 'unavailable' : ''}`}>
     <input type="checkbox" checked={checked} disabled={busy || !available} aria-label={`复制 ${source.name} · ${preview.endpoint?.name} · ${source.claimed_model}`} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, source.id])] : current.filter(id => id !== source.id))} />
     <div><div className="clone-source-title"><strong>{source.name}</strong><span>{PROTOCOL_LABEL[source.protocol]} · {TIER_LABEL[source.tier]}档</span></div><ConnectionContext compact station={preview.endpoint?.station_name || '—'} keyName={preview.endpoint?.name || '—'} group={groups.get(preview.endpoint?.group_id || '') || '—'} /><small className="clone-source-model">来源模型：{source.claimed_model}</small>
      {preview.status === 'incompatible' && <small className="clone-source-state">模型系列不同，需选择对应的 GPT / Claude 来源以保留协议。</small>}
      {preview.status === 'existing' && <small className="clone-source-state existing"><Check size={12} />已有相同测试，勾选后直接复用。</small>}
      {preview.status === 'duplicate' && <small className="clone-source-state">同一连接已有等价来源，选择上面的配置即可。</small>}
     </div>
    </label>;
   })}{!visible.length && <p className="clone-no-sources">没有匹配的来源配置。</p>}</div>
  </section>
  {previews.length > 0 && <section className="clone-preview" aria-label="复制配置预览"><div className="clone-preview-head"><h3>添加前预览</h3><span>{ready.length} 个新增 · {existing.length} 个已有</span></div><div className="clone-preview-list">{previews.map(preview => <article key={preview.sourceId} className="clone-preview-card"><header><strong>{preview.source?.name || '来源已删除'}</strong><span>{preview.status === 'ready' ? '新增' : preview.status === 'existing' ? '复用已有' : preview.status === 'duplicate' ? '合并重复选择' : '无法复制'}</span></header><ConnectionContext compact station={preview.endpoint?.station_name || '—'} keyName={preview.endpoint?.name || '—'} group={groups.get(preview.endpoint?.group_id || '') || '—'} /><div className="clone-model-change"><span>{preview.source?.claimed_model}</span><ArrowRight size={14} aria-label="更换为" /><strong>{claimed || '待选择'}</strong></div>
    <label className="field"><span>实际请求模型名 · {preview.endpoint?.name}</span><input value={preview.requestModel} required maxLength={256} disabled={busy} onChange={event => setAliases(current => ({ ...current, [preview.sourceId]: event.target.value }))} /></label>
    <p className="clone-preserved-settings">{preview.source && PROTOCOL_LABEL[preview.source.protocol]} · {preview.source && TIER_LABEL[preview.source.tier]}档 · {preview.schedule?.enabled ? preview.schedule.kind === 'daily' ? `监测：每天 ${preview.schedule.daily_time}` : `监测：每 ${preview.schedule.interval_minutes} 分钟` : '自动监测关闭'}</p>
    {!preview.supported && <p className="clone-source-state"><CircleHelp size={13} />当前协议没有对应基准，可先保存配置，暂不支持判定。</p>}
   </article>)}</div></section>}
  <div className="note"><ShieldCheck size={17} /><span>沿用已保存的 Key，无需重填。监测开关、频率和档位也会复制；已开启监测的新目标按其计划运行。</span></div>
  <div className="clone-save-summary"><strong>{ready.length ? `准备为 ${stations} 家中转站添加 ${ready.length} 个 ${claimed} 测试` : existing.length ? `可查看 ${existing.length} 个已配置测试` : '先选择模型，再勾选来源配置'}</strong><p>保存完成后自动进入该模型的检测视图，可一键检测这些目标。</p></div>
  <div className="form-actions"><span>本次仅保存配置</span><button className="button primary" disabled={busy || invalid}><CopyPlus size={16} />{busy ? '添加中…' : ready.length ? `一键添加 ${ready.length} 个测试` : '查看已有测试'}</button></div>
 </form>;
}
