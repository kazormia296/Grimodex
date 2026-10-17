#!/bin/bash
set -e
cd /home/grimodex/worktrees/Grimodex/claude-nir1-measure/src-tauri
sed -i -E "s/pub const MAX_GRAPH_NODES: usize = [0-9]+;/pub const MAX_GRAPH_NODES: usize = 50;/; s/pub const MAX_GRAPH_EDGES: usize = [0-9]+;/pub const MAX_GRAPH_EDGES: usize = 512;/; s/pub const MAX_GRAPH_RECORDS: usize = [0-9]+;/pub const MAX_GRAPH_RECORDS: usize = 2048;/" crates/grimodex-core/src/narrative_nir1.rs
sed -i -E "s/pub\(crate\) const QUERY_SQL_STEPS: u64 = [0-9_]+;/pub(crate) const QUERY_SQL_STEPS: u64 = 600000;/; s/const QUERY_MAX_PAGES: usize = [0-9]+;/const QUERY_MAX_PAGES: usize = 128;/" crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
grep -n 'QUERY_DEADLINE: Duration' crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
MEASURE_Q_BYTES=33554432 cargo build --release --locked -p grimodex-db --bin nir1-c-query-worker > /tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/raw/build-worker-candB-100ms.txt 2>&1
cp target/release/nir1-c-query-worker /tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/worker-candB-100ms-q32MiB
cargo test --release --locked -p grimodex-db --lib --no-run > /tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/raw/build-test-candB-100ms.txt 2>&1
cp target/release/deps/grimodex_db-7f44700dae3feeed /tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/bin/test-candB-100ms
echo built > /tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/raw/candB-100ms.done
