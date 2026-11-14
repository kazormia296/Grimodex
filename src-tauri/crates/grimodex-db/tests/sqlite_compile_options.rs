//! DR-DBC-4: the bundled SQLite is built with the flags the audits and the
//! measurements assume. `.cargo/config.toml` adds
//! `-DSQLITE_ENABLE_MEMORY_MANAGEMENT` through `LIBSQLITE3_FLAGS` because
//! libsqlite3-sys 0.39 stopped passing it. This test runs in `--release` too (the
//! shipped worker and addon are release builds).

#[test]
fn bundled_sqlite_keeps_the_flags_of_the_0_38_build() {
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
