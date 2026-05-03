// Yunomia v3 — Tauri library entry. Spawns ptys, bridges them to the frontend
// over Tauri events. Frontend mounts an xterm.js per pty.

mod pty;
mod store;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let registry = pty::PtyRegistry::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(registry)
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            store::models_get,
            store::models_set,
            store::enumerate_sessions,
        ])
        .setup(|app| {
            let _window = app.get_webview_window("main").expect("main window missing");
            store::start_sentinel_watcher(app.handle().clone());
            log::info!("Yunomia v3 shell up");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                log::info!("Yunomia v3 shell exiting");
            }
        });
}
