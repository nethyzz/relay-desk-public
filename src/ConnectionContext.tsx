import { Folder, LockKeyhole, Server } from 'lucide-react';

export default function ConnectionContext({ station, keyName, group, compact = false }: { station: string; keyName: string; group: string; compact?: boolean }) {
 return <dl className={`connection-context ${compact ? 'compact' : ''}`} aria-label="中转站、Key 配置与分组">
  <div><dt><Server size={12} />中转站</dt><dd>{station}</dd></div>
  <div><dt><LockKeyhole size={12} />Key 配置</dt><dd>{keyName}</dd></div>
  <div><dt><Folder size={12} />所属分组</dt><dd>{group}</dd></div>
 </dl>;
}
