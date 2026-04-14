//! Content directory reader – reads scene Markdown files by scene_id.

use std::path::{Path, PathBuf};

/// Extract the first 8 characters of a UUID/ID to use as a short identifier.
fn short_id(scene_id: &str) -> &str {
    let end = scene_id
        .char_indices()
        .nth(8)
        .map(|(i, _)| i)
        .unwrap_or(scene_id.len());
    &scene_id[..end]
}

/// Find an existing file for this scene_id by scanning for *_{short_id}.md.
fn find_existing(dir: &Path, scene_id: &str) -> Option<PathBuf> {
    let sid = short_id(scene_id);
    let suffix = format!("_{sid}.md");
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(&suffix) {
            return Some(entry.path());
        }
    }
    None
}

/// Read the Markdown content for a scene.
/// Returns empty string if no file exists for this scene_id.
pub fn read_scene_markdown(dir: &Path, scene_id: &str) -> anyhow::Result<String> {
    match find_existing(dir, scene_id) {
        Some(path) => Ok(std::fs::read_to_string(&path)?),
        None => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("grimodex_mcp_content_{name}"));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_read_finds_by_short_id() {
        let dir = temp_dir("read1");
        let id = "abcdef12-0000-0000-0000-000000000000";
        // Create a file with the hybrid naming convention
        fs::write(dir.join("01-01_テスト_abcdef12.md"), "# Scene content").unwrap();
        let text = read_scene_markdown(&dir, id).unwrap();
        assert_eq!(text, "# Scene content");
    }

    #[test]
    fn test_read_nonexistent_returns_empty() {
        let dir = temp_dir("read2");
        let text = read_scene_markdown(&dir, "nonexistent-id").unwrap();
        assert_eq!(text, "");
    }
}
