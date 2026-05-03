// Yunomia v3 — Tauri shell entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yunomia_v3_lib::run()
}
