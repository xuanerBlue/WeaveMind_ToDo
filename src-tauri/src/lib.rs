use notify::{RecursiveMode, Watcher};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

// 读取任意用户选定的绝对路径（自定义命令不受 fs 插件 scope 限制）。
// 文件不存在时返回空串。
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

// 配置存放在系统 app config 目录下的 settings.json
fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<String, String> {
    let p = config_file(&app)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let p = config_file(&app)?;
    fs::write(&p, contents).map_err(|e| e.to_string())
}

// 选文件：非阻塞回调 + oneshot，全程不阻塞主线程。
#[tauri::command]
async fn pick_todo_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.ok().flatten().map(|fp| fp.to_string())
}

/// 默认待办文件的位置：应用数据目录。
///
/// 刻意**不放** .app 内部或 Program Files：前者会被覆盖安装连带删掉（更新即丢数据），
/// 后者写入需要管理员权限。应用数据目录不会被更新触及，也不需要特殊权限。
/// 这里只建目录不建文件，内容由前端首次写入。
#[tauri::command]
fn default_todo_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ToDo.md").to_string_lossy().to_string())
}

/// 新建待办文件：保存对话框，用户自己挑位置和文件名。
/// 与 pick_todo_file 同样走「异步命令 + 非阻塞回调 + oneshot」，原因见 DEVELOPMENT.md 5.1。
#[tauri::command]
async fn create_todo_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name("ToDo.md")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.ok().flatten().map(|fp| fp.to_string())
}

/// 在系统文件管理器里定位这个文件（让用户能自己打开、拷走、迁移）。
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").args(["-R", &path]).spawn();

    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let spawned = std::process::Command::new("xdg-open").arg(&path).spawn();

    spawned.map(|_| ()).map_err(|e| e.to_string())
}

// 文件监听：监视目标文件所在目录（比直接监视文件更耐受编辑器的原子保存），
// 命中目标文件变化时向前端发送 "todo-file-changed"。
#[derive(Default)]
struct WatcherState(Mutex<Option<notify::RecommendedWatcher>>);

#[tauri::command]
fn watch_file(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| target.clone());
    let target_cb = target.clone();
    let app_cb = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let hit = event.paths.iter().any(|p| p == &target_cb);
            if hit && (event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove())
            {
                let _ = app_cb.emit("todo-file-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // 替换旧的 watcher（drop 掉即停止旧监听）
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            load_config,
            save_config,
            pick_todo_file,
            default_todo_path,
            create_todo_file,
            reveal_path,
            watch_file
        ])
        .setup(|app| {
            // 系统托盘菜单：显示/隐藏面板、开机自启（可勾选）、退出
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

            let show_item = MenuItemBuilder::with_id("show", "显示/隐藏面板").build(app)?;
            let autostart_item = CheckMenuItemBuilder::with_id("autostart", "开机自启")
                .checked(autostart_on)
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&autostart_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let autostart_cb = autostart_item.clone();
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("WeaveMind 待办")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        let _ = app.emit("tray-show-panel", ());
                    }
                    "autostart" => {
                        let mgr = app.autolaunch();
                        let enabled = mgr.is_enabled().unwrap_or(false);
                        let _ = if enabled { mgr.disable() } else { mgr.enable() };
                        let _ = autostart_cb.set_checked(!enabled);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
