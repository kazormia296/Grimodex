use serde::Serialize;

use crate::commands::AppResult;
use grimodex_lint::MAX_INPUT_BYTES;

#[derive(Serialize)]
pub struct BunsetsuDto {
    pub start: u32,
    pub end: u32,
    pub surface: String,
}

/// 段落プレーンテキストを文節境界（UTF-16 offset）に分割する。
#[tauri::command]
pub fn segment_bunsetsu(text: String) -> AppResult<Vec<BunsetsuDto>> {
    if text.len() > MAX_INPUT_BYTES {
        return Err(
            anyhow::anyhow!("text exceeds maximum length of {} bytes", MAX_INPUT_BYTES).into(),
        );
    }
    let chunks =
        grimodex_lint::bunsetsu::segment_bunsetsu(&text).map_err(|e| anyhow::anyhow!(e))?;
    Ok(chunks
        .into_iter()
        .map(|c| BunsetsuDto {
            start: c.start,
            end: c.end,
            surface: c.surface,
        })
        .collect())
}
