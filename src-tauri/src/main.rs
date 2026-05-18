// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// `devtools` feature を有効にしたデバッグ用 release ビルドではコンソールを残す
#![cfg_attr(
    all(not(debug_assertions), not(feature = "devtools")),
    windows_subsystem = "windows"
)]

fn main() {
    grimodex_lib::run()
}
