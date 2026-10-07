import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Check, ChevronDown, Layers3, Plus, Search, X } from 'lucide-react';
import { modelFamily } from './target-cloning.ts';

interface ModelOption { model: string; count?: number }
interface Props {
 label: string;
 value: string;
 models: ModelOption[];
 change: (model: string) => void;
 disabled?: boolean;
 allCount?: number;
 custom?: () => void;
 customSelected?: boolean;
 placeholder?: string;
}
type Family = 'all' | 'gpt' | 'claude' | 'other';
const FAMILY_LABEL = { gpt: 'GPT', claude: 'Claude', other: '其他模型' };

export default function ModelPicker({ label, value, models, change, disabled, allCount, custom, customSelected, placeholder = '请选择模型' }: Props) {
 const [open, setOpen] = useState(false);
 const [query, setQuery] = useState('');
 const [family, setFamily] = useState<Family>('all');
 const dialog = useRef<HTMLDialogElement>(null);
 const trigger = useRef<HTMLButtonElement>(null);
 const id = useId();
 useEffect(() => {
  if (!open) return;
  const element = dialog.current;
  element?.showModal();
  element?.querySelector<HTMLInputElement>('input')?.focus();
  return () => { element?.close(); trigger.current?.focus({ preventScroll: true }); };
 }, [open]);
 const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 const options = [...models].sort((a, b) => (b.count || 0) - (a.count || 0)).filter(option => words.every(word => option.model.toLocaleLowerCase().includes(word)) && (family === 'all' || (modelFamily(option.model) || 'other') === family));
 const groups = (['gpt', 'claude', 'other'] as const).map(kind => ({ kind, options: options.filter(option => (modelFamily(option.model) || 'other') === kind) })).filter(group => group.options.length);
 const current = customSelected ? value || '自定义模型' : value === 'all' && allCount !== undefined ? '全部检测模型' : value || placeholder;
 const count = value === 'all' ? allCount : models.find(option => option.model === value)?.count;
 const choose = (model: string) => { if (disabled) return; change(model); setOpen(false); };
 const navigateOptions = (event: KeyboardEvent<HTMLDivElement>) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-model-option]')];
  const index = buttons.indexOf(event.target);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
 };
 return <>
  <button type="button" ref={trigger} className="button model-selector-trigger" disabled={disabled} aria-label={`选择${label}，当前：${current}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} title={current} onClick={() => { setQuery(''); setFamily('all'); setOpen(true); }}><Activity size={16} /><strong>{current}</strong>{count !== undefined && <span className="model-selector-count">{count}</span>}<ChevronDown size={15} /></button>
  {open && createPortal(<dialog ref={dialog} id={id} className="dialog model-picker-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); event.stopPropagation(); setOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
   <div className="dialog-head"><h2 id={`${id}-title`}>选择{label}</h2><button type="button" className="icon-button" aria-label="关闭模型选择" onClick={() => setOpen(false)}><X size={20} /></button></div>
   <div className="model-picker-body">
    <label className="model-picker-search"><Search size={17} /><input autoFocus value={query} aria-label="搜索模型" placeholder="搜索模型，例如 sol 或 Claude" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
     if (event.key === 'Enter' && options.length === 1) { event.preventDefault(); choose(options[0].model); }
     if (event.key === 'ArrowDown') { event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('[data-model-option]')?.focus(); }
    }} />{query && <button type="button" className="icon-button" aria-label="清空模型搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label>
    <div className="model-picker-tabs" role="group" aria-label="模型系列">{(['all', 'gpt', 'claude', ...(models.some(option => !modelFamily(option.model)) ? ['other'] : [])] as Family[]).map(kind => <button type="button" key={kind} className={family === kind ? 'active' : ''} aria-pressed={family === kind} onClick={() => setFamily(kind)}>{kind === 'all' ? '全部' : FAMILY_LABEL[kind]}</button>)}</div>
    <div className="model-picker-options" role="group" aria-label="可选检测模型" onKeyDown={navigateOptions}>
     {allCount !== undefined && !query.trim() && family === 'all' && <button type="button" data-model-option className={`model-picker-option all ${value === 'all' ? 'active' : ''}`} onClick={() => choose('all')}><Layers3 size={17} /><strong>全部检测模型</strong><span>{allCount} 个测试</span>{value === 'all' && <Check size={17} />}</button>}
     {groups.map(group => <section className="model-picker-group" key={group.kind} aria-label={`${FAMILY_LABEL[group.kind]} 模型`}><h3>{FAMILY_LABEL[group.kind]}</h3>{group.options.map(option => <button type="button" data-model-option key={option.model} title={option.model} className={`model-picker-option ${value === option.model && !customSelected ? 'active' : ''}`} onClick={() => choose(option.model)}><strong>{option.model}</strong>{option.count !== undefined && <span>{option.count ? `${option.count} 个测试` : '未配置'}</span>}{value === option.model && !customSelected && <Check size={17} />}</button>)}</section>)}
     {!options.length && <p className="model-picker-empty">没有找到匹配的模型。</p>}
    </div>
    {custom && <button type="button" className="button model-picker-custom" onClick={() => { if (!disabled) { custom(); setOpen(false); } }}><Plus size={16} />自定义模型</button>}
   </div>
  </dialog>, document.body)}
 </>;
}
