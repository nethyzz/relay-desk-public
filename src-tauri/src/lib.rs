use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex}, time::Duration};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

const OWNER: &str = "com.relaydesk.local";
const MARKER: &str = ".relay-desk-owner";

#[cfg(any(target_os = "ios", all(test, target_vendor = "apple")))]
fn exclude_device_backup(directory: &Path) -> Result<(), String> {
    use objc2_foundation::{NSNumber, NSString, NSURL, NSURLIsExcludedFromBackupKey};
    let path = NSString::from_str(&directory.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path);
    let flag = NSNumber::numberWithBool(true);
    // Apple defines this resource key's value as NSNumber/Bool.
    unsafe { url.setResourceValue_forKey_error(Some(&flag), NSURLIsExcludedFromBackupKey) }.map_err(|_| "无法排除设备自动备份".into())
}

struct LocalRuntime {
    directory: PathBuf,
    generation: AtomicU64,
    writes: Mutex<()>,
    requests: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    client: reqwest::Client,
    _lock: fs::File,
    quitting: AtomicBool,
}
#[derive(Serialize, Deserialize)]
#[allow(non_snake_case)]
struct Secrets { SESSION_SECRET: String, MASTER_KEY: String, LOCAL_RUNNER_TOKEN: String }
#[derive(Serialize)]
struct Bootstrap { generation: u64, database: String, secrets: Secrets, directory: String }
#[derive(Serialize, Deserialize)]
struct Restore { database: String, secrets: Secrets }
fn secret(size: usize) -> Result<String, String> {
    let mut bytes = vec![0; size]; getrandom::fill(&mut bytes).map_err(|_| "无法生成本机密钥")?; Ok(STANDARD.encode(bytes))
}
fn private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("应用文件不能是符号链接".into()); }
    let temporary = path.with_file_name(format!("{}.pending", path.file_name().unwrap_or_default().to_string_lossy()));
    if fs::symlink_metadata(&temporary).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("应用临时文件不能是符号链接".into()); }
    use std::io::Write;
    let mut options = fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temporary).map_err(|_| "无法写入应用数据")?;
    file.write_all(bytes).map_err(|_| "应用数据写入失败")?;
    file.sync_all().map_err(|_| "应用数据保存失败")?;
    fs::rename(&temporary, path).map_err(|_| "应用数据替换失败")?;
    Ok(())
}
fn owned_directory(directory: &Path) -> Result<(), String> {
    if fs::symlink_metadata(directory).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("应用目录不能是符号链接".into()); }
    fs::create_dir_all(directory).map_err(|_| "无法创建应用数据目录")?;
    for name in [MARKER, "panel.sqlite", "secrets.json", "restore.json", ".app.lock"] {
        if fs::symlink_metadata(directory.join(name)).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("应用数据不能是符号链接".into()); }
    }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护应用目录")?; }
    let marker = directory.join(MARKER);
    if marker.exists() {
        if fs::read_to_string(marker).unwrap_or_default() != OWNER { return Err("该目录属于其他应用".into()); }
    } else {
        if directory.join("panel.sqlite").exists() || directory.join("secrets.json").exists() { return Err("发现未登记的数据，未覆盖现有文件".into()); }
        private_file(&marker, OWNER.as_bytes())?;
    }
    Ok(())
}
#[tauri::command]
fn load_local_state(runtime: State<'_, LocalRuntime>) -> Result<Bootstrap, String> {
    let _guard = runtime.writes.lock().map_err(|_| "本地存储正在重启")?;
    owned_directory(&runtime.directory)?;
    complete_restore(&runtime.directory)?;
    let key_path = runtime.directory.join("secrets.json");
    let database_path = runtime.directory.join("panel.sqlite");
    let secrets = if key_path.exists() {
        serde_json::from_slice(&fs::read(&key_path).map_err(|_| "无法读取本机密钥")?).map_err(|_| "本机密钥文件损坏，请恢复备份")?
    } else {
        if database_path.exists() { return Err("数据库存在但解密密钥缺失，请恢复备份".into()); }
        let value = Secrets { SESSION_SECRET: secret(48)?, MASTER_KEY: secret(32)?, LOCAL_RUNNER_TOKEN: secret(32)? };
        private_file(&key_path, &serde_json::to_vec(&value).map_err(|_| "密钥保存失败")?)?;
        value
    };
    let database = if database_path.exists() { STANDARD.encode(fs::read(&database_path).map_err(|_| "无法读取本地数据库")?) } else { String::new() };
    Ok(Bootstrap { generation: runtime.generation.load(Ordering::SeqCst), database, secrets, directory: runtime.directory.to_string_lossy().into_owned() })
}
#[tauri::command]
fn save_local_database(database: String, generation: u64, runtime: State<'_, LocalRuntime>) -> Result<(), String> {
    let _guard = runtime.writes.lock().map_err(|_| "本地存储正在重启")?;
    if generation != runtime.generation.load(Ordering::SeqCst) { return Err("旧的运行环境已关闭".into()); }
    if database.len() > 256 * 1024 * 1024 { return Err("本地数据库过大，请备份旧报告".into()); }
    let bytes = STANDARD.decode(database).map_err(|_| "数据库内容无效")?;
    if !bytes.starts_with(b"SQLite format 3\0") { return Err("数据库格式无效".into()); }
    owned_directory(&runtime.directory)?;
    private_file(&runtime.directory.join("panel.sqlite"), &bytes)
}
fn complete_restore(directory: &Path) -> Result<(), String> {
    let journal = directory.join("restore.json");
    if !journal.exists() { return Ok(()); }
    let restore: Restore = serde_json::from_slice(&fs::read(&journal).map_err(|_| "无法读取恢复记录")?).map_err(|_| "恢复记录损坏，请保留文件并重试备份恢复")?;
    let database = STANDARD.decode(restore.database).map_err(|_| "备份内容无效")?;
    private_file(&directory.join("secrets.json"), &serde_json::to_vec(&restore.secrets).map_err(|_| "密钥恢复失败")?)?;
    private_file(&directory.join("panel.sqlite"), &database)?;
    fs::remove_file(journal).map_err(|_| "恢复记录清理失败")?;
    Ok(())
}
#[tauri::command]
fn restore_local_state(database: String, master_key: String, runtime: State<'_, LocalRuntime>) -> Result<(), String> {
    let _guard = runtime.writes.lock().map_err(|_| "本地存储正在重启")?;
    if database.len() > 256 * 1024 * 1024 || STANDARD.decode(&master_key).map_err(|_| "备份密钥无效")?.len() != 32 { return Err("备份内容无效".into()); }
    if !STANDARD.decode(&database).map_err(|_| "备份数据库无效")?.starts_with(b"SQLite format 3\0") { return Err("备份数据库格式无效".into()); }
    owned_directory(&runtime.directory)?;
    let restore = Restore { database, secrets: Secrets { MASTER_KEY: master_key, SESSION_SECRET: secret(48)?, LOCAL_RUNNER_TOKEN: secret(32)? } };
    // Replayable private journal keeps the database and its encryption key
    // together even when the operating system kills the app during restore.
    private_file(&runtime.directory.join("restore.json"), &serde_json::to_vec(&restore).map_err(|_| "恢复记录保存失败")?)?;
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    complete_restore(&runtime.directory)
}
#[tauri::command]
fn reset_local_data(runtime: State<'_, LocalRuntime>, window: tauri::WebviewWindow) -> Result<(), String> {
    let _guard = runtime.writes.lock().map_err(|_| "本地存储正在重启")?;
    owned_directory(&runtime.directory)?;
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    for cancel in runtime.requests.lock().map_err(|_| "网络任务正在结束")?.drain().map(|(_, sender)| sender) { let _ = cancel.send(()); }
    for name in ["panel.sqlite", "panel.sqlite.pending", "secrets.json", "secrets.json.pending", "restore.json", "restore.json.pending"] {
        let path = runtime.directory.join(name);
        if path.exists() { fs::remove_file(path).map_err(|_| "部分本地数据未删除，请退出应用后重试")?; }
    }
    window.clear_all_browsing_data().map_err(|_| "浏览器数据未完全清理")?;
    Ok(())
}
#[derive(Deserialize)]
struct HttpInput { id: String, url: String, method: String, headers: HashMap<String, String>, body: String }
#[derive(Serialize)]
struct HttpReply { status: u16, headers: HashMap<String, String>, body_base64: String }
fn public_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "地址格式无效")?;
    let host = url.host_str().ok_or("目标没有域名")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().map(|p| p != 443).unwrap_or(false)
        || host.parse::<std::net::IpAddr>().is_ok() || !host.contains('.') || host.ends_with(".local") || host.ends_with(".localhost") || host.ends_with(".internal") {
        return Err("仅允许公网 HTTPS 域名".into());
    }
    Ok(url)
}
#[tauri::command]
async fn native_http(input: HttpInput, runtime: State<'_, LocalRuntime>) -> Result<HttpReply, String> {
    let url = public_url(&input.url)?;
    let method = reqwest::Method::from_bytes(input.method.as_bytes()).map_err(|_| "请求方法无效")?;
    if method != reqwest::Method::GET && method != reqwest::Method::POST { return Err("请求方法不支持".into()); }
    if input.body.len() > 1048576 { return Err("请求过大".into()); }
    let mut request = runtime.client.request(method, url).body(input.body);
    for (key, value) in input.headers { request = request.header(&key, &value); }
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    runtime.requests.lock().map_err(|_| "网络任务正在结束")?.insert(input.id.clone(), cancel);
    let task = async move {
        let mut response = request.send().await.map_err(|_| "无法连接目标，请检查网络或代理")?;
        let status = response.status().as_u16();
        let headers = response.headers().iter().filter_map(|(k,v)| v.to_str().ok().map(|s| (k.to_string(),s.to_string()))).collect();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "响应中断")? {
            if bytes.len() + chunk.len() > 1048576 { return Err("模型响应超过大小限制".into()); }
            bytes.extend_from_slice(&chunk);
        }
        Ok(HttpReply { status, headers, body_base64: STANDARD.encode(bytes) })
    };
    let result = tokio::select! { result = task => result, _ = cancelled => Err("请求已取消".into()) };
    runtime.requests.lock().map_err(|_| "网络任务正在结束")?.remove(&input.id);
    result
}
#[tauri::command]
fn cancel_http(id: String, runtime: State<'_, LocalRuntime>) {
    if let Ok(mut requests) = runtime.requests.lock() { if let Some(cancel) = requests.remove(&id) { let _ = cancel.send(()); } }
}
#[tauri::command]
fn quit_local_app(app: tauri::AppHandle, runtime: State<'_, LocalRuntime>) {
    runtime.quitting.store(true, Ordering::SeqCst);
    if let Ok(mut requests) = runtime.requests.lock() { for (_, cancel) in requests.drain() { let _ = cancel.send(()); } }
    app.exit(0);
}

#[cfg(any(target_os = "ios", test))]
struct TemporaryExport(Option<PathBuf>);
#[cfg(any(target_os = "ios", test))]
impl Drop for TemporaryExport {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
            let pending = path.with_file_name(format!("{}.pending", path.file_name().unwrap_or_default().to_string_lossy()));
            let _ = fs::remove_file(pending);
        }
    }
}
#[cfg(any(target_os = "ios", test))]
fn prepare_temporary_export(directory: &Path, name: &str, contents: &[u8]) -> Result<(String, TemporaryExport), String> {
    let mut token = [0u8; 12];
    getrandom::fill(&mut token).map_err(|_| "无法准备导出文件")?;
    let token: String = token.iter().map(|byte| format!("{byte:02x}")).collect();
    let filename = format!("{}-{token}.json", name.trim_end_matches(".json"));
    let temporary = TemporaryExport(Some(directory.join(&filename)));
    private_file(temporary.0.as_ref().unwrap(), contents)?;
    Ok((filename, temporary))
}

#[tauri::command]
async fn export_local_file(name: String, contents: String, app: tauri::AppHandle) -> Result<bool, String> {
    if name.contains('/') || name.contains('\\') || !name.ends_with(".json") || contents.len() > 256 * 1024 * 1024 { return Err("导出文件无效".into()); }
    // iOS exports a source document before returning a destination URL. Supply
    // the real encrypted backup/report first; remove this private source when
    // the picker completes or is cancelled, including failure paths.
    #[cfg(target_os = "ios")]
    let (name, mut temporary_export) = prepare_temporary_export(&app.path().document_dir().map_err(|_| "无法准备导出位置")?, &name, contents.as_bytes())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(&name).add_filter("JSON", &["json"]).save_file(move |path| { let _ = sender.send(path); });
    let path = receiver.await.map_err(|_| "保存窗口已关闭")?;
    if let Some(path) = path {
        #[cfg(target_os = "ios")]
        if path.clone().into_path().ok().as_ref() == temporary_export.0.as_ref() { temporary_export.0 = None; }
        use std::io::Write;
        let mut options = tauri_plugin_fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
        let mut file = app.fs().open(path.clone(), options).map_err(|_| "无法写入选定位置")?;
        let result = file.write_all(contents.as_bytes()).and_then(|_| file.sync_all());
        drop(file);
        #[cfg(target_os = "ios")] { let _ = app.fs().stop_accessing_security_scoped_resource(path); }
        result.map_err(|_| "导出保存失败")?;
        return Ok(true);
    }
    Ok(false)
}
#[derive(Deserialize)]
struct SmtpInput { host: String, port: u16, username: String, password: String, from: String, to: String, message: String }
#[derive(Serialize)]
struct SmtpReply { ok: bool, error_code: Option<&'static str> }
#[tauri::command]
async fn native_smtp(input: SmtpInput) -> Result<SmtpReply, String> {
    use lettre::{address::Envelope, transport::smtp::authentication::Credentials, AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    public_url(&format!("https://{}", input.host))?;
    let sender = input.from.parse().map_err(|_| "发件邮箱无效")?;
    let recipients: Result<Vec<lettre::Address>, _> = input.to.split(',').map(|address| address.trim().parse()).collect();
    let envelope = Envelope::new(Some(sender), recipients.map_err(|_| "收件邮箱无效")?).map_err(|_| "收件邮箱为空")?;
    let bytes = STANDARD.decode(input.message).map_err(|_| "邮件内容无效")?;
    if bytes.len() > 4 * 1024 * 1024 { return Err("邮件内容过大".into()); }
    let builder = if input.port == 465 { AsyncSmtpTransport::<Tokio1Executor>::relay(&input.host) } else { AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&input.host) }.map_err(|_| "邮件服务器配置无效")?;
    let transport = builder.port(input.port).credentials(Credentials::new(input.username, input.password)).timeout(Some(Duration::from_secs(30))).build();
    let result = tokio::time::timeout(Duration::from_secs(45), transport.send_raw(&envelope, &bytes)).await;
    let error_code = match result {
        Ok(Ok(_)) => None,
        Ok(Err(error)) if error.is_tls() => Some("smtp_tls"),
        Ok(Err(error)) if error.status().map(|code| code.to_string() == "535" || code.to_string() == "534").unwrap_or(false) => Some("smtp_auth"),
        Ok(Err(error)) if error.is_transient() => Some("smtp_busy"),
        Ok(Err(error)) if error.is_permanent() => Some("smtp_rejected"),
        _ => Some("smtp_connect"),
    };
    Ok(SmtpReply { ok: error_code.is_none(), error_code })
}
#[tauri::command]
fn clear_local_cache(window: tauri::WebviewWindow) -> Result<(), String> { window.clear_all_browsing_data().map_err(|_| "界面缓存未清理完成".into()) }
#[tauri::command]
fn show_data_directory(app: tauri::AppHandle, runtime: State<'_, LocalRuntime>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(runtime.directory.to_string_lossy().into_owned(), None::<&str>).map_err(|_| "无法打开应用数据目录".into())
}
fn client() -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120));
    #[cfg(target_os = "macos")] {
        if let Ok(output) = std::process::Command::new("/usr/sbin/scutil").arg("--proxy").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            let value = |name: &str| text.lines().find_map(|line| line.trim().strip_prefix(&format!("{name} : ")).map(str::trim));
            if value("HTTPSEnable") == Some("1") {
                if let (Some(host), Some(port)) = (value("HTTPSProxy"), value("HTTPSPort")) {
                    if let Ok(proxy) = reqwest::Proxy::all(format!("http://{host}:{port}")) { builder = builder.proxy(proxy); }
                }
            }
        }
    }
    builder.build()
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let directory = std::env::var_os("RELAY_DESK_DATA_DIR").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            owned_directory(&directory).map_err(std::io::Error::other)?;
            #[cfg(target_os = "ios")] exclude_device_backup(&directory).map_err(std::io::Error::other)?;
            let mut options = fs::OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let lock = options.open(directory.join(".app.lock"))?;
            lock.try_lock().map_err(|_| std::io::Error::other("Relay Desk 已在运行，请使用现有窗口"))?;
            app.manage(LocalRuntime { directory, generation: AtomicU64::new(1), writes: Mutex::new(()), requests: Mutex::new(HashMap::new()), client: client()?, _lock: lock, quitting: AtomicBool::new(false) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_local_state, save_local_database, restore_local_state, reset_local_data, native_http, cancel_http, native_smtp, quit_local_app, export_local_file, clear_local_cache, show_data_directory])
        .build(tauri::generate_context!())
        .expect("无法启动 Relay Desk 本地应用")
        .run(|app, event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<LocalRuntime>().quitting.load(Ordering::SeqCst) { api.prevent_exit(); let _ = app.emit("relay-app-close", ()); }
            }
            #[cfg(mobile)] let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
                .join(".app-build/native-unit-temp")
                .join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn private_writes_replace_data_without_leaving_temporary_files() {
        let directory = Directory::new();
        owned_directory(&directory.0).unwrap();
        let path = directory.0.join("panel.sqlite");
        private_file(&path, b"first").unwrap();
        private_file(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!directory.0.join("panel.sqlite.pending").exists());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn unrelated_data_is_preserved() {
        let directory = Directory::new();
        fs::write(directory.0.join("panel.sqlite"), b"unrelated").unwrap();
        assert!(owned_directory(&directory.0).is_err());
        assert_eq!(fs::read(directory.0.join("panel.sqlite")).unwrap(), b"unrelated");
        fs::write(directory.0.join(MARKER), "another.application").unwrap();
        assert!(owned_directory(&directory.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_redirect_app_writes() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let unrelated = directory.0.join("unrelated");
        fs::write(&unrelated, b"keep").unwrap();
        symlink(&unrelated, directory.0.join("panel.sqlite")).unwrap();
        assert!(owned_directory(&directory.0).is_err());
        assert!(private_file(&directory.0.join("panel.sqlite"), b"replace").is_err());
        assert_eq!(fs::read(unrelated).unwrap(), b"keep");
    }

    #[test]
    fn interrupted_restore_replays_the_key_and_database_together() {
        let directory = Directory::new();
        owned_directory(&directory.0).unwrap();
        let restore = Restore {
            database: STANDARD.encode(b"SQLite format 3\0fixture"),
            secrets: Secrets { SESSION_SECRET: secret(48).unwrap(), MASTER_KEY: secret(32).unwrap(), LOCAL_RUNNER_TOKEN: secret(32).unwrap() },
        };
        let key = restore.secrets.MASTER_KEY.clone();
        private_file(&directory.0.join("restore.json"), &serde_json::to_vec(&restore).unwrap()).unwrap();
        complete_restore(&directory.0).unwrap();
        let restored: Secrets = serde_json::from_slice(&fs::read(directory.0.join("secrets.json")).unwrap()).unwrap();
        assert_eq!(restored.MASTER_KEY, key);
        assert_eq!(fs::read(directory.0.join("panel.sqlite")).unwrap(), b"SQLite format 3\0fixture");
        assert!(!directory.0.join("restore.json").exists());
        complete_restore(&directory.0).unwrap();
    }

    #[test]
    fn malformed_restore_keeps_existing_data_and_the_recovery_record() {
        let directory = Directory::new();
        fs::write(directory.0.join("panel.sqlite"), b"keep").unwrap();
        fs::write(directory.0.join("restore.json"), b"invalid").unwrap();
        assert!(complete_restore(&directory.0).is_err());
        assert_eq!(fs::read(directory.0.join("panel.sqlite")).unwrap(), b"keep");
        assert!(directory.0.join("restore.json").exists());
    }

    #[test]
    fn only_one_process_can_own_the_same_database() {
        let directory = Directory::new();
        let path = directory.0.join(".app.lock");
        let first = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path).unwrap();
        first.try_lock().unwrap();
        let second = fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        assert!(second.try_lock().is_err());
        drop(first);
        second.try_lock().unwrap();
    }

    #[test]
    fn network_targets_reject_local_addresses_credentials_and_redirect_ports() {
        for raw in ["http://api.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://host.local", "https://user:secret@api.example.com", "https://api.example.com:8080"] {
            assert!(public_url(raw).is_err(), "accepted {raw}");
        }
        assert!(public_url("https://api.example.com/v1").is_ok());
    }

    #[test]
    fn ios_export_source_contains_real_data_and_is_removed_when_the_picker_ends() {
        let directory = Directory::new();
        let (name, temporary) = prepare_temporary_export(&directory.0, "backup.json", b"encrypted fixture").unwrap();
        assert_eq!(fs::read(directory.0.join(&name)).unwrap(), b"encrypted fixture");
        assert!(name.starts_with("backup-") && name.ends_with(".json"));
        drop(temporary);
        assert!(!directory.0.join(name).exists());
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn apple_private_data_can_be_excluded_from_device_backup() {
        let directory = Directory::new();
        exclude_device_backup(&directory.0).unwrap();
    }
}
