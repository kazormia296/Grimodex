//! DR-DBC-4: this crate builds its own copy of the bundled SQLite (its own
//! `Cargo.lock` and target directory), so the flags are asserted here as well as
//! in grimodex-db. `.cargo/config.toml` adds `-DSQLITE_ENABLE_MEMORY_MANAGEMENT`
//! through `LIBSQLITE3_FLAGS`; cargo finds that file from this directory too.

#[test]
fn the_addons_bundled_sqlite_keeps_the_flags_of_the_0_38_build() {
    let options = grimodex_db::sqlite_compile_options().expect("compile options");
    for expected in [
        "ENABLE_MEMORY_MANAGEMENT",
        "ENABLE_FTS5",
        "ENABLE_STAT4",
        "ENABLE_API_ARMOR",
        "ENABLE_COLUMN_METADATA",
        "THREADSAFE=1",
    ] {
        assert!(
            options.iter().any(|option| option == expected),
            "SQLite is built without {expected}: {options:?}"
        );
    }
}
