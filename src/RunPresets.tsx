import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Pencil, Play, Plus, Star, Trash2 } from 'lucide-react';
import ConnectionContext from './ConnectionContext.tsx';
import { BASELINES, DETECTION_BATCH_SIZE, plannedRequests, PROTOCOL_LABEL, TIER_LABEL, type PanelData, type RunPreset, type Target } from './shared.ts';

function supported(target: Target) { return BASELINES[target.protocol].models.includes(target.claimed_model); }
function requestCount(targets: Target[]) { return targets.filter(supported).reduce((sum, target) => sum + plannedRequests(target.protocol, target.tier).logical, 0); }

export function RunPresetList({ data, busy, create, edit, remove, start }: { data: PanelData; busy: boolean; create: () => void; edit: (value: RunPreset) => void; remove: (value: RunPreset) => void; start: (ids: string[]) => void }) {
 const presets = data.run_presets || [];
 const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem('relay-run-presets-open') === 'true'; } catch { return false; } });
 const toggle = () => { const next = !expanded; setExpanded(next); try { localStorage.setItem('relay-run-presets-open', String(next)); } catch { /* 展开状态仍可用于当前页面。 */ } };
 return <section className={`run-presets ${expanded ? 'expanded' : 'collapsed'}`} aria-label="常用检测组合">
  <div className="section-head preset-section-head"><h2><button className="preset-toggle" type="button" aria-label={`${expanded ? '收起' : '展开'}常用检测组合`} aria-expanded={expanded} aria-controls="run-presets-content" onClick={toggle}><Star size={19} />常用检测组合{presets.length > 0 && <span className="preset-count">{presets.length}</span>}<span className="preset-toggle-hint">{expanded ? '收起' : '展开'}</span>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button></h2>{expanded && <button className="button small" disabled={busy || !data.targets.length} onClick={create}><Plus size={15} />新建组合</button>}</div>
  <div id="run-presets-content" hidden={!expanded}><p className="preset-intro">把经常一起检测的模型存成组合，可跨分组、跨中转站，不受下方筛选影响。</p>
  {!presets.length ? <div className="preset-empty"><Star size={17} /><p>选择几个常用模型，保存后就能在这里一键检测。</p></div> : <div className="preset-grid">{presets.map(preset => {
   const targets = preset.target_ids.map(id => data.targets.find(target => target.id === id)).filter((target): target is Target => !!target);
   const eligible = targets.filter(supported);
   return <article key={preset.id} className="preset-card">
    <div className="preset-card-head"><div><h3>{preset.name}</h3><span>{targets.length} 个模型 · 预计 {requestCount(targets)} 次首轮请求</span></div><div className="preset-management"><button className="icon-button" disabled={busy} aria-label={`编辑常用组合 ${preset.name}`} title="编辑组合" onClick={() => edit(preset)}><Pencil size={16} /></button><button className="icon-button danger-text" disabled={busy} aria-label={`删除常用组合 ${preset.name}`} title="删除组合" onClick={() => remove(preset)}><Trash2 size={16} /></button></div></div>
    <ul className="preset-members">{targets.map(target => {
     const endpoint = data.endpoints.find(endpoint => endpoint.id === target.endpoint_id);
     return <li key={target.id}><strong>{target.name}<span>{TIER_LABEL[target.tier]}</span></strong><small>中转站：{endpoint?.station_name || '—'} · 分组：{data.groups.find(group => group.id === endpoint?.group_id)?.name || '默认分组'} · Key：{endpoint?.name || '—'}</small></li>;
    })}</ul>
    {eligible.length < targets.length && <p className="preset-warning">{targets.length - eligible.length} 个模型暂无对应基准，检测时会跳过。</p>}
    {!targets.length && <p className="preset-warning">组合内的模型已移除，请编辑组合重新选择。</p>}
    <button className="button primary small preset-start" disabled={busy || !eligible.length} aria-label={`检测常用组合 ${preset.name}`} onClick={() => start(preset.target_ids)}><Play size={15} />检测组合{eligible.length > 0 && <span>（{eligible.length}）</span>}</button>
   </article>;
  })}</div>}</div>
 </section>;
}

export function RunPresetForm({ data, value, initialTargetIds = [], busy, save }: { data: PanelData; value?: RunPreset; initialTargetIds?: string[]; busy: boolean; save: (path: string, method: string, body: unknown) => Promise<void> }) {
 const [selected, setSelected] = useState<string[]>(() => (value?.target_ids || initialTargetIds).filter(id => data.targets.some(target => target.id === id)));
 const chosen = data.targets.filter(target => selected.includes(target.id));
 const eligible = chosen.filter(supported);
 return <form className="form preset-form" onSubmit={event => { event.preventDefault(); save('run-presets', 'POST', { id: value?.id, name: new FormData(event.currentTarget).get('name'), targetIds: selected }); }}>
  <label className="field"><span>组合名称</span><input name="name" defaultValue={value?.name} placeholder="例如：日常检测、常用线路" required maxLength={64} autoFocus disabled={busy} /></label>
  <div className="preset-choice-head"><div><h3>选择组合内的模型</h3><p>这里列出全部模型，可以跨分组、跨中转站勾选。</p></div><div><button className="button small" type="button" disabled={busy || !data.targets.length} onClick={() => setSelected(data.targets.map(target => target.id))}>全选</button><button className="button small" type="button" disabled={busy || !selected.length} onClick={() => setSelected([])}>清空</button></div></div>
  <div className="preset-target-list" role="group" aria-label="组合可选模型">{data.targets.map(target => {
   const endpoint = data.endpoints.find(endpoint => endpoint.id === target.endpoint_id);
   return <label key={target.id} className={`preset-target ${selected.includes(target.id) ? 'selected' : ''}`}>
    <input type="checkbox" checked={selected.includes(target.id)} disabled={busy} aria-label={`加入常用组合 ${target.name}`} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, target.id])] : current.filter(id => id !== target.id))} />
    <div><div className="preset-target-head"><strong>{target.name}</strong><span>{PROTOCOL_LABEL[target.protocol]} · {TIER_LABEL[target.tier]}档</span></div><ConnectionContext compact station={endpoint?.station_name || '—'} keyName={endpoint?.name || '—'} group={data.groups.find(group => group.id === endpoint?.group_id)?.name || '默认分组'} />{!supported(target) && <small className="preset-warning">暂无对应基准，可保存；发起检测时会跳过。</small>}</div>
   </label>;
  })}</div>
  <div className="preset-summary"><Check size={17} /><div><strong>已选 {chosen.length} 个模型 · 预计 {requestCount(chosen)} 次首轮请求</strong><p>检测时沿用各模型最新的 Key 和默认档位；每批最多 {DETECTION_BATCH_SIZE} 个并发，其余自动排队，重试另计。{eligible.length < chosen.length && `其中 ${chosen.length - eligible.length} 个模型暂无对应基准。`}</p></div></div>
  <p className="form-help">保存组合不会发起检测。{data.mail.enabled && data.mail.notify_manual ? '点击检测组合后，全部结束时发送一封汇总邮件。' : '检测结果保存在面板，发送邮件取决于你的手动检测通知设置。'}</p>
  <div className="form-actions"><button className="button primary" disabled={busy || !chosen.length}>{busy ? '保存中…' : '保存常用组合'}</button></div>
 </form>;
}
