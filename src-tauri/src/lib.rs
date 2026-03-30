mod database;

use database::Database;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
struct QueryResult {
    rows: Vec<serde_json::Map<String, Value>>,
}

#[tauri::command]
fn db_execute(
    state: tauri::State<'_, Database>,
    sql: String,
    params: Vec<Value>,
    method: String,
) -> Result<QueryResult, AppError> {
    let rows = state.execute(&sql, &params, &method)?;
    Ok(QueryResult { rows })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_dir).ok();
            let db_path = app_dir.join("noveloom.db");
            let database =
                Database::new(&db_path).expect("failed to open database");
            database.migrate().expect("failed to migrate database");
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_execute])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
