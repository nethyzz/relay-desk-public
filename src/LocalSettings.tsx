import { useEffect, useState, type FormEvent } from 'react';
import { Database, Download, FolderOpen, RefreshCw, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { clearLocalCache, exportLocalFile, localControl, resetLocal, restoreLocal, showLocalDirectory } from '../apps/local/client.ts';
import { decryptBackup, encryptBackup, type BackupData } from '../apps/local/backup.ts';

export default function LocalSettings({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [directory, setDirectory] = useState('正在读取…');
  const [mode, setMode] = useState<'backup' | 'restore' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);
  const mobile = /iPhone|iPad|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  useEffect(() => { void localControl<{ directory: string }>('info').then(info => setDirectory(info.directory)).catch(() => setDirectory('暂时无法读取')); }, []);
  const perform = async (operation: () => Promise<void>) => { setBusy(true); try { await operation(); } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); } };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    void perform(async () => {
      if (mode === 'backup') {
        const password = String(values.get('password'));
        if (password !== values.get('confirm')) throw new Error('两次备份密码不一致。');
        const data = await localControl<BackupData>('backup');
        const contents = await encryptBackup(data, password);
        if (await exportLocalFile(`relay-backup-${new Date().toISOString().slice(0, 10)}.json`, contents)) { setMode(null); notify('加密备份已导出。请保存好密码，其他设备恢复时需要使用。'); }
      } else if (mode === 'restore') {
        const file = values.get('file');
        if (!(file instanceof File) || !file.size) throw new Error('请选择加密备份文件。');
        if (file.size > 256 * 1024 * 1024) throw new Error('备份文件超过大小限制。');
        const data = await decryptBackup(await file.text(), String(values.get('password')));
        await restoreLocal(data);
      } else if (mode === 'reset') {
        if (values.get('confirmation') !== '清空') throw new Error('请输入“清空”确认删除本机应用数据。');
        await resetLocal();
      }
    });
  };
  return <section className="settings-panel local-storage-panel">
    <div className="settings-heading"><span className="station-icon"><Database size={23} /></span><div><h2>本机数据与备份</h2><p>站点、Key 和报告保存在这台设备。检测时直接连接你配置的模型服务。</p></div></div>
    <div className="local-storage-note"><ShieldCheck size={18} /><span>API Key 和邮箱授权码加密保存。备份再用独立密码加密，可以在其他设备上手动恢复。</span></div>
    <div className="local-storage-actions">
      <button className="button" disabled={busy} onClick={() => setMode('backup')}><Download size={16} />导出加密备份</button>
      <button className="button" disabled={busy} onClick={() => setMode('restore')}><Upload size={16} />恢复备份</button>
      <button className="button" disabled={busy} onClick={() => void perform(async () => { await clearLocalCache(); notify('界面缓存已清理，站点、Key 和报告已保留。'); })}><RefreshCw size={16} />清理缓存</button>
      <button className="button danger" disabled={busy} onClick={() => setMode('reset')}><Trash2 size={16} />清空本机数据</button>
    </div>
    {mode && <form className="form local-storage-form" onSubmit={submit}>
      <div className="local-form-heading"><h3>{mode === 'backup' ? '加密备份' : mode === 'restore' ? '恢复到这台设备' : '删除这台设备上的数据'}</h3><button type="button" className="icon-button" disabled={busy} aria-label="取消数据操作" onClick={() => setMode(null)}><X size={18} /></button></div>
      {mode === 'restore' && <><p className="note">恢复会替换本机的全部站点、Key、报告和设置，停止任务并关闭监测计划。恢复前请先导出需要保留的数据；之后可手动重新开启监测。</p><label className="field"><span>加密备份文件</span><input type="file" name="file" accept=".json,application/json" required /></label></>}
      {mode !== 'reset' ? <>
        <label className="field"><span>备份密码</span><input name="password" type="password" autoComplete={mode === 'backup' ? 'new-password' : 'off'} minLength={mode === 'backup' ? 10 : undefined} maxLength={1024} required /><small>{mode === 'backup' ? '至少 10 个字符。密码不会随备份保存，遗忘后无法恢复。' : '填写导出这份备份时使用的密码。'}</small></label>
        {mode === 'backup' && <label className="field"><span>再次输入密码</span><input name="confirm" type="password" autoComplete="new-password" required /></label>}
      </> : <><p className="note error-text">这会停止当前任务，永久删除本机保存的站点、Key、报告、邮箱设置及界面缓存。已导出的文件需要在文件管理器中另行删除。</p><label className="field"><span>输入“清空”确认</span><input name="confirmation" autoComplete="off" required pattern="清空" /></label></>}
      <div className="form-actions"><button className={`button ${mode === 'reset' ? 'danger' : 'primary'}`} disabled={busy}>{busy ? '处理中…' : mode === 'backup' ? '选择保存位置' : mode === 'restore' ? '替换本机数据并恢复' : '清空本机数据'}</button></div>
    </form>}
    <div className="local-directory"><span>数据位置</span><code>{directory}</code>{!mobile && <button className="button small" disabled={busy} onClick={() => void perform(showLocalDirectory)}><FolderOpen size={14} />打开文件夹</button>}</div>
    <p className="form-help">{mobile ? '检测期间请保持应用在前台。卸载时选择删除应用，系统会删除应用私有数据；“卸载 App”可能保留数据。' : '卸载前先在这里清空本机数据，然后删除应用或使用系统卸载程序。关闭应用会停止检测并释放运行内存；自动监测需要应用保持打开。'}</p>
  </section>;
}
