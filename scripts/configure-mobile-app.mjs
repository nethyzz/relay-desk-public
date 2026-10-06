import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const platform = process.argv[2];
if (platform === 'android') {
  const root = resolve('src-tauri/gen/android/app/src/main');
  const manifestPath = root + '/AndroidManifest.xml';
  if (!existsSync(manifestPath)) throw new Error('请先运行 npm run app:android -- init。');
  let manifest = readFileSync(manifestPath, 'utf8');
  const values = { allowBackup: 'false', fullBackupContent: '@xml/backup_rules', dataExtractionRules: '@xml/data_extraction_rules' };
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`android:${name}="[^"]*"`);
    manifest = pattern.test(manifest) ? manifest.replace(pattern, `android:${name}="${value}"`) : manifest.replace('<application', `<application android:${name}="${value}"`);
  }
  writeFileSync(manifestPath, manifest);
  mkdirSync(root + '/res/xml', { recursive: true });
  const excludes = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'].map(domain => `    <exclude domain="${domain}" path="." />`).join('\n');
  writeFileSync(root + '/res/xml/backup_rules.xml', `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n${excludes}\n</full-backup-content>\n`);
  writeFileSync(root + '/res/xml/data_extraction_rules.xml', `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup disableIfNoEncryptionCapabilities="true">\n${excludes}\n  </cloud-backup>\n  <device-transfer>\n${excludes}\n  </device-transfer>\n</data-extraction-rules>\n`);
  console.log('Android 应用私有数据已排除自动备份与设备迁移；导出的加密备份由用户管理。');
} else if (platform === 'ios') {
  if (!existsSync('src-tauri/gen/apple')) throw new Error('请先使用完整 Xcode 运行 npm run app:ios -- init。');
  console.log('iPhone 检测需要保持前台；数据使用应用私有目录，迁移通过加密备份。');
} else throw new Error('未知移动平台。');
