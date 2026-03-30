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

    #[test]
    fn test_write_and_read() {
        let dir = std::env::temp_dir().join("noveloom_content_test");
        let content = ContentDir::new(dir.clone()).expect("create content dir");

        content
            .write("scene-abc", "# Scene ABC\n\nHello world")
            .expect("write");
        let text = content.read("scene-abc").expect("read");
        assert_eq!(text, "# Scene ABC\n\nHello world");

        // Cleanup
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_read_nonexistent_returns_empty() {
        let dir = std::env::temp_dir().join("noveloom_content_test_empty");
        let content = ContentDir::new(dir.clone()).expect("create content dir");

        let text = content.read("nonexistent").expect("read");
        assert_eq!(text, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_delete() {
        let dir = std::env::temp_dir().join("noveloom_content_test_del");
        let content = ContentDir::new(dir.clone()).expect("create content dir");

        content.write("to-delete", "content").expect("write");
        content.delete("to-delete").expect("delete");
        let text = content.read("to-delete").expect("read after delete");
        assert_eq!(text, "");

        std::fs::remove_dir_all(&dir).ok();
    }
}
