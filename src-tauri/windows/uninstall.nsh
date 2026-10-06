!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTUNINSTALL
  ; This app never uninstalls the shared Microsoft WebView2 runtime.
  IfFileExists "$APPDATA\com.relaydesk.local\.relay-desk-owner" 0 relay_cleanup_done
  FileOpen $0 "$APPDATA\com.relaydesk.local\.relay-desk-owner" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "com.relaydesk.local" 0 relay_cleanup_done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 Relay Desk 的本机站点、Key、报告、邮箱设置及专属缓存？已导出的备份文件将保留。" IDYES relay_cleanup_apply IDNO relay_cleanup_done
  relay_cleanup_apply:
    RMDir /r "$APPDATA\com.relaydesk.local"
    RMDir /r "$LOCALAPPDATA\com.relaydesk.local"
  relay_cleanup_done:
!macroend
