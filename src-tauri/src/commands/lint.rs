#[tauri::command]
pub(crate) fn lint_text(
    blocks: Vec<grimodex_lint::LintBlock>,
    language: String,
    scope: grimodex_lint::LintScope,
    config: grimodex_lint::LintConfig,
    disables: Option<Vec<grimodex_lint::DisableDirective>>,
) -> Result<grimodex_lint::LintResponse, grimodex_lint::LintError> {
    let lang = match language.as_str() {
        "ja" => grimodex_lint::Language::Japanese,
        "en" => grimodex_lint::Language::English,
        other => return Err(grimodex_lint::LintError::InvalidLanguage(other.to_string())),
    };
    let disables = disables.unwrap_or_default();
    grimodex_lint::lint(&blocks, lang, scope, &config, &disables)
}
