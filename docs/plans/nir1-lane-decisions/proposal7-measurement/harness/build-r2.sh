#!/bin/bash
# round-2 builds: candB constants; worker with MEASURE_Q_BYTES / MEASURE_NATIVE_BYTES; test binaries with 100 ms and 10 s deadlines
set -e
eval "$(fnm env --shell bash)" 2>/dev/null || true
P=/tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7
R=$P/r2
cd /home/grimodex/worktrees/Grimodex/claude-nir1-measure/src-tauri
sed -i -E "s/pub const MAX_GRAPH_NODES: usize = [0-9]+;/pub const MAX_GRAPH_NODES: usize = 50;/; s/pub const MAX_GRAPH_EDGES: usize = [0-9]+;/pub const MAX_GRAPH_EDGES: usize = 512;/; s/pub const MAX_GRAPH_RECORDS: usize = [0-9]+;/pub const MAX_GRAPH_RECORDS: usize = 2048;/" crates/grimodex-core/src/narrative_nir1.rs
sed -i -E "s/pub\(crate\) const QUERY_SQL_STEPS: u64 = [0-9_]+;/pub(crate) const QUERY_SQL_STEPS: u64 = 600000;/; s/const QUERY_MAX_PAGES: usize = [0-9]+;/const QUERY_MAX_PAGES: usize = 128;/" crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
for cfg in "16777216 3145728 q16-n3" "8388608 3145728 q8-n3" "16777216 1572864 q16-n15"; do
  set -- $cfg
  MEASURE_Q_BYTES=$1 MEASURE_NATIVE_BYTES=$2 cargo build --release --locked -p grimodex-db --bin nir1-c-query-worker > $R/build-worker-$3.txt 2>&1
  cp target/release/nir1-c-query-worker $R/worker-candB-$3
done
cargo test --release --locked -p grimodex-db --lib --no-run > $R/build-test-candB-100ms.txt 2>&1
cp "$(ls -t target/release/deps/grimodex_db-* | grep -v '\.d$' | head -1)" $R/test-candB-100ms
sed -i -E 's/(pub\(crate\) const QUERY_DEADLINE: Duration = Duration::from_millis\()100\)/\110_000)/' crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
grep -n 'QUERY_DEADLINE: Duration' crates/grimodex-db/src/narrative_extraction/nir1_graph.rs > $R/deadline-line.txt
cargo test --release --locked -p grimodex-db --lib --no-run > $R/build-test-candB-10s.txt 2>&1
cp "$(ls -t target/release/deps/grimodex_db-* | grep -v '\.d$' | head -1)" $R/test-candB-10s
# restore production constants
git checkout crates/grimodex-core/src/narrative_nir1.rs
sed -i -E "s/pub\(crate\) const QUERY_SQL_STEPS: u64 = [0-9_]+;/pub(crate) const QUERY_SQL_STEPS: u64 = 100_000;/; s/const QUERY_MAX_PAGES: usize = [0-9]+;/const QUERY_MAX_PAGES: usize = 32;/; s/(pub\(crate\) const QUERY_DEADLINE: Duration = Duration::from_millis\()10_000\)/\1100)/" crates/grimodex-db/src/narrative_extraction/nir1_graph.rs
echo built > $R/built.done
