use grimodex_db::{schema_contract::inspect_connection, Database};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let output = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "src/db/generated/schema-contract.json".to_owned());

    let db = Database::new(Path::new(":memory:"))?;
    db.migrate()?;
    let contract = db.with_conn(inspect_connection)?;
    let json = format!("{}\n", serde_json::to_string_pretty(&contract)?);

    if output == "-" {
        print!("{json}");
        return Ok(());
    }

    let output_path = Path::new(&output);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output_path, json)?;
    Ok(())
}
