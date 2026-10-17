#!/bin/bash
set -e
R=/tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/r2
cd /home/grimodex/worktrees/Grimodex/claude-nir1-measure/src-tauri
sed -i -E "s/pub const MAX_GRAPH_NODES: usize = [0-9]+;/pub const MAX_GRAPH_NODES: usize = 50;/; s/pub const MAX_GRAPH_EDGES: usize = [0-9]+;/pub const MAX_GRAPH_EDGES: usize = 512;/; s/pub const MAX_GRAPH_RECORDS: usize = [0-9]+;/pub const MAX_GRAPH_RECORDS: usize = 2048;/" crates/grimodex-core/src/narrative_nir1.rs
sed -i -E "s/pub\(crate\) const QUERY_SQL_STEPS: u64 = [0-9_]+;/pub(crate) const QUERY_SQL_STEPS: u64 = 600000;/; s/const QUERY_MAX_PAGES: usize = [0-9]+;/const QUERY_MAX_PAGES: usize = 128;/; s/(pub\(crate\) const QUERY_DEADLINE: Duration = Duration::from_millis\()100\)/\110_000)/" crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
MEASURE_Q_BYTES=16777216 MEASURE_NATIVE_BYTES=3145728 cargo build --release --locked -p grimodex-db --bin nir1-c-query-worker > $R/build-worker-candB10s-q16-n3.txt 2>&1
cp target/release/nir1-c-query-worker $R/worker-candB10s-q16-n3
git checkout crates/grimodex-core/src/narrative_nir1.rs
sed -i -E "s/pub\(crate\) const QUERY_SQL_STEPS: u64 = [0-9_]+;/pub(crate) const QUERY_SQL_STEPS: u64 = 100_000;/; s/const QUERY_MAX_PAGES: usize = [0-9]+;/const QUERY_MAX_PAGES: usize = 32;/; s/(pub\(crate\) const QUERY_DEADLINE: Duration = Duration::from_millis\()10_000\)/\1100)/" crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
echo ok > $R/w10s.done
