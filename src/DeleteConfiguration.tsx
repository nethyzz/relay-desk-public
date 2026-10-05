import { LockKeyhole, ShieldCheck, Trash2 } from 'lucide-react';
import { configurationDeletion, type ConfigurationSelection } from './configuration-deletion.ts';
import { PROTOCOL_LABEL, type PanelData } from './shared.ts';

export default function DeleteConfiguration({ data, selection, busy, cancel, save }: { data: PanelData; selection: ConfigurationSelection; busy: boolean; cancel: () => void; save: (path: string, method: string, body: unknown) => void }) {
 const plan = configurationDeletion(data, selection);
 if (!plan) return <div className="form"><p>这个配置已不存在，请刷新列表后查看。</p><div className="form-actions"><button className="button" onClick={cancel}>关闭</button></div></div>;
 return <div className="form delete-configuration">
  <div className="delete-config-intro"><strong>删除「{plan.name}」？</strong><p>{selection.kind === 'station' ? '删除这家中转站在所有分组中的 Key 配置和模型，不只当前筛选的分组。' : selection.kind === 'key' ? '删除这条 Key 配置及其全部检测模型，同一中转站的其他 Key 保留。' : '只删除这个检测模型，同一 Key 下的其他模型和 Key 配置保留。'}</p></div>
  <div className="delete-config-context"><span>{plan.station}</span><code>{plan.baseUrl}</code></div>
  <div className="delete-config-counts"><span><strong>{selection.kind === 'model' ? 0 : plan.profiles.length}</strong> 条 Key 配置</span><span><strong>{plan.models.length}</strong> 个检测模型</span><span><strong>{plan.enabledSchedules}</strong> 个自动监测计划</span></div>
  {plan.models.length > 0 && <section className="delete-config-models" aria-label="将删除的检测模型"><h3>将删除的检测模型</h3><ul>{plan.models.map(model => <li key={model.id}><strong>{model.name}</strong><small>{plan.profiles.find(profile => profile.id === model.endpoint_id)?.name} · {PROTOCOL_LABEL[model.protocol]}</small></li>)}</ul></section>}
  <div className="note"><ShieldCheck size={17} /><span>历史报告和已取得的检测证据会保留，可继续在“检测报告”中查看和导出。</span></div>
  {selection.kind !== 'model' && <p className="delete-config-credential"><LockKeyhole size={14} />删除的 Key 将从已保存凭据中清除，其他站点和 Key 不受影响。</p>}
  <p className="form-help">相关监测计划会移除，常用组合中的这些模型也会移除。{plan.emptiedPresets > 0 && `其中 ${plan.emptiedPresets} 个组合将变为空，随之移除。`}删除后如需使用，需要重新添加配置。</p>
  {plan.activeRuns.length > 0 && <div className="note error-text" role="alert">有 {plan.activeRuns.length} 个检测仍在排队或运行。请先停止检测，等待结束后再删除；当前配置尚未删除。</div>}
  <div className="form-actions"><button className="button" disabled={busy} onClick={cancel}>取消</button><button className="button danger" disabled={busy || plan.activeRuns.length > 0} onClick={() => save(plan.path, 'DELETE', plan.request)}><Trash2 size={15} />{busy ? '删除中…' : `确认删除${selection.kind === 'key' ? ' ' : ''}${plan.label}`}</button></div>
 </div>;
}
