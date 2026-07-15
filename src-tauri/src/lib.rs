use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// 读取任意用户选定的绝对路径（自定义命令不受 fs 插件 scope 限制）。
// 文件不存在时返回空串，方便"选了一个还不存在的 Todo.md"这种情况。
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

// 在 Rust 端选文件：用非阻塞回调 + oneshot 通道。
// 对话框在主线程弹出，异步命令等待回调结果，全程不阻塞主线程
// （blocking_pick_file 会让主线程去跑 NSOpenPanel，在 macOS 上崩溃）。
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            load_config,
            save_config,
            pick_todo_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
