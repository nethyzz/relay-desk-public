#!/bin/zsh
# Defaults to a preview. It only removes this app's registered private paths.
set -eu
app_path='/Applications/Relay Desk.app'
apply=0
keep_app=0
while (( $# )); do
  case "$1" in
    --apply) apply=1; shift ;;
    --keep-app) keep_app=1; shift ;;
    --app) app_path="$2"; shift 2 ;;
    *) print '用法：卸载清理.command [--apply] [--keep-app] [--app /路径/Relay\ Desk.app]'; exit 2 ;;
  esac
done
identifier='com.relaydesk.local'
data_path="$HOME/Library/Application Support/$identifier"
if [[ -L "$data_path" || -L "$app_path" ]]; then print '拒绝清理符号链接。'; exit 1; fi
if [[ -d "$app_path" ]]; then
  actual_identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")
  if [[ "$actual_identifier" != "$identifier" ]]; then print '选定的应用不是 Relay Desk 本地版，未删除任何文件。'; exit 1; fi
fi
paths=()
if [[ -f "$data_path/.relay-desk-owner" && ! -L "$data_path/.relay-desk-owner" ]]; then
  if [[ "$(< "$data_path/.relay-desk-owner")" != "$identifier" ]]; then print '数据目录登记不符，未删除任何文件。'; exit 1; fi
  paths+=("$data_path" "$HOME/Library/WebKit/$identifier" "$HOME/Library/Caches/$identifier" "$HOME/Library/Preferences/$identifier.plist" "$HOME/Library/Saved Application State/$identifier.savedState")
elif [[ -e "$data_path" ]]; then
  print '发现未登记的数据目录，未删除任何文件。'; exit 1
fi
if (( ! keep_app )) && [[ -d "$app_path" ]]; then paths+=("$app_path"); fi
for item in "${paths[@]}"; do
  if [[ -L "$item" ]]; then print '拒绝清理符号链接。'; exit 1; fi
done
if (( apply )) && /usr/bin/pgrep -x relay-desk-local >/dev/null; then print '请先退出 Relay Desk，再执行卸载清理。'; exit 1; fi
print '清理范围：本机应用、站点、Key、报告、邮箱设置和专属 WebView 缓存。导出的备份与项目数据保留。'
for item in "${paths[@]}"; do
  if [[ -e "$item" ]]; then
    label='预览'; if (( apply )); then label='清理'; fi
    print -r -- "${label}：${item}"
    if (( apply )); then /bin/rm -rf -- "$item"; fi
  fi
done
if (( ! apply )); then print '当前仅预览。确认范围后，加 --apply 执行。'; else print 'Relay Desk 本机卸载清理完成。'; fi
