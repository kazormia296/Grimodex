/// Validate a capture-relative path independently of the host operating
/// system. Captures store portable resource identities, never host paths.
pub fn validate_relative_path(path: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!path.is_empty(), "relative path must not be empty");
    anyhow::ensure!(
        !path.starts_with('/') && !path.starts_with('\\'),
        "absolute paths are not allowed in import captures"
    );
    anyhow::ensure!(
        !has_drive_prefix(path),
        "drive-letter paths are not allowed in import captures"
    );

    for segment in path.split(['/', '\\']) {
        anyhow::ensure!(
            segment != "..",
            "parent-directory segments are not allowed in import captures"
        );
    }
    Ok(())
}

/// Symlinks must be resolved by a future native picker rather than captured as
/// filesystem references. This keeps capture identity portable and bounded.
pub fn reject_symlink_kind(kind: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !matches!(kind, "symlink" | "symbolic-link"),
        "symlink resources are not supported by import capture"
    );
    Ok(())
}

fn has_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::validate_relative_path;

    #[test]
    fn accepts_normal_portable_paths() {
        validate_relative_path("chapters/opening.md").expect("valid path");
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert!(validate_relative_path("/chapter.md").is_err());
        assert!(validate_relative_path(r"C:\chapter.md").is_err());
    }
}
