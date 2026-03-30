use std::path::PathBuf;
use std::sync::Mutex;

pub struct ContentDir {
    base: Mutex<PathBuf>,
}

impl ContentDir {
    pub fn new(base: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&base)?;
        Ok(Self {
            base: Mutex::new(base),
        })
    }

    pub fn write(&self, scene_id: &str, markdown: &str) -> anyhow::Result<()> {
        let base = self.base.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let path = base.join(format!("{scene_id}.md"));
        std::fs::write(&path, markdown)?;
        Ok(())
    }

    pub fn read(&self, scene_id: &str) -> anyhow::Result<String> {
        let base = self.base.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let path = base.join(format!("{scene_id}.md"));
        if path.exists() {
            Ok(std::fs::read_to_string(&path)?)
        } else {
            Ok(String::new())
        }
    }

    pub fn delete(&self, scene_id: &str) -> anyhow::Result<()> {
        let base = self.base.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let path = base.join(format!("{scene_id}.md"));
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("noveloom_content_{name}"))
    }

    fn cleanup(dir: &PathBuf) {
        std::fs::remove_dir_all(dir).ok();
    }

    // --- Hybrid filename tests ---

    #[test]
    fn test_write_creates_hybrid_filename() {
        let dir = temp_dir("hybrid_write");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "a3f1b2c4-7e2d-9f01-c8b4-e3a2deadbeef";
        content
            .write(id, "# Hello", "プロローグ", 1, 1)
            .expect("write");

        // File should be named 01-01_プロローグ_a3f1b2c4.md
        let expected = dir.join("01-01_プロローグ_a3f1b2c4.md");
        assert!(expected.exists(), "hybrid filename should exist");

        let text = std::fs::read_to_string(&expected).expect("read file");
        assert_eq!(text, "# Hello");

        cleanup(&dir);
    }

    #[test]
    fn test_read_finds_by_short_id() {
        let dir = temp_dir("hybrid_read");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "b1234567-aaaa-bbbb-cccc-ddddeeeeaaaa";
        content
            .write(id, "content here", "冒頭の出会い", 1, 2)
            .expect("write");

        // read only needs scene_id, finds by short_id glob
        let text = content.read(id).expect("read");
        assert_eq!(text, "content here");

        cleanup(&dir);
    }

    #[test]
    fn test_read_nonexistent_returns_empty() {
        let dir = temp_dir("hybrid_read_empty");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let text = content.read("nonexistent-id").expect("read");
        assert_eq!(text, "");

        cleanup(&dir);
    }

    #[test]
    fn test_delete_removes_file() {
        let dir = temp_dir("hybrid_delete");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "deadbeef-1111-2222-3333-444455556666";
        content
            .write(id, "to delete", "削除テスト", 2, 1)
            .expect("write");
        content.delete(id).expect("delete");

        let text = content.read(id).expect("read after delete");
        assert_eq!(text, "");

        cleanup(&dir);
    }

    #[test]
    fn test_write_overwrites_with_new_filename() {
        let dir = temp_dir("hybrid_overwrite");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "cafebabe-0000-1111-2222-333344445555";
        content
            .write(id, "v1", "旧タイトル", 1, 1)
            .expect("write v1");

        // Write again with different title/order — old file should be removed
        content
            .write(id, "v2", "新タイトル", 2, 3)
            .expect("write v2");

        let old_path = dir.join("01-01_旧タイトル_cafebabe.md");
        let new_path = dir.join("02-03_新タイトル_cafebabe.md");
        assert!(!old_path.exists(), "old file should be removed");
        assert!(new_path.exists(), "new file should exist");

        let text = content.read(id).expect("read");
        assert_eq!(text, "v2");

        cleanup(&dir);
    }

    #[test]
    fn test_sanitize_special_chars_in_title() {
        let dir = temp_dir("hybrid_sanitize");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "11112222-3333-4444-5555-666677778888";
        // Title with characters invalid on Windows: / \ : * ? " < > |
        content
            .write(id, "body", "a/b\\c:d*e?f\"g<h>i|j", 1, 1)
            .expect("write");

        let text = content.read(id).expect("read");
        assert_eq!(text, "body");

        // Verify no special chars in the actual filename
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        let fname = entries[0].file_name().to_string_lossy().to_string();
        assert!(fname.ends_with("_11112222.md"));
        // Should not contain any of the forbidden chars
        for c in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
            assert!(!fname.contains(c), "filename should not contain '{c}'");
        }

        cleanup(&dir);
    }

    #[test]
    fn test_long_title_is_truncated() {
        let dir = temp_dir("hybrid_long");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "aabbccdd-1111-2222-3333-444455556666";
        let long_title = "あ".repeat(200);
        content
            .write(id, "body", &long_title, 1, 1)
            .expect("write");

        let text = content.read(id).expect("read");
        assert_eq!(text, "body");

        // Filename should not be excessively long
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        let fname = entries[0].file_name().to_string_lossy().to_string();
        // Total filename length should be reasonable (under 100 chars)
        assert!(
            fname.len() < 150,
            "filename too long: {} chars",
            fname.len()
        );

        cleanup(&dir);
    }

    #[test]
    fn test_rename_updates_filename() {
        let dir = temp_dir("hybrid_rename");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "eeeeaaaa-bbbb-cccc-dddd-111122223333";
        content
            .write(id, "body", "元の名前", 1, 1)
            .expect("write");

        content
            .rename(id, "新しい名前", 1, 2)
            .expect("rename");

        let old_path = dir.join("01-01_元の名前_eeeeaaaa.md");
        let new_path = dir.join("01-02_新しい名前_eeeeaaaa.md");
        assert!(!old_path.exists(), "old file should not exist");
        assert!(new_path.exists(), "new file should exist");

        let text = content.read(id).expect("read after rename");
        assert_eq!(text, "body");

        cleanup(&dir);
    }

    #[test]
    fn test_empty_title_uses_untitled() {
        let dir = temp_dir("hybrid_empty_title");
        cleanup(&dir);
        let content = ContentDir::new(dir.clone()).expect("create");

        let id = "00001111-2222-3333-4444-555566667777";
        content
            .write(id, "body", "", 1, 1)
            .expect("write");

        let entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        let fname = entries[0].file_name().to_string_lossy().to_string();
        assert!(
            fname.contains("untitled") || fname.contains("無題"),
            "empty title should become a placeholder: {fname}"
        );

        cleanup(&dir);
    }
}
