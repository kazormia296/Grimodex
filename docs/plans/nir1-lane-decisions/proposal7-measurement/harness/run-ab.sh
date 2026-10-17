#!/bin/bash
P=/tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7
cd /home/grimodex/worktrees/Grimodex/claude-nir1-measure/src-tauri
for c in 200 600 2000; do
  P7_SUMMARY_CHARS=$c P7_SHAPES=20:scene,30:scene,50:scene P7_SEEDS=m1,c01,m5 P7_REPS=3 P7_NO_REVSIZES=1 $P/bin/test-raised --ignored --nocapture --test-threads=1 p7_matrix > $P/raw/matrix-raised-sum$c.txt 2>&1
done
P7_CAST=8:40 P7_SEEDS=cast P7_SHAPES=50:scene,100:scene P7_REPS=1 P7_NO_REVSIZES=1 $P/bin/test-raised --ignored --nocapture --test-threads=1 p7_matrix > $P/raw/matrix-raised-cast8x40.txt 2>&1
P7_CAST=12:80 P7_SEEDS=cast P7_SHAPES=50:scene P7_REPS=1 P7_NO_REVSIZES=1 $P/bin/test-raised --ignored --nocapture --test-threads=1 p7_matrix > $P/raw/matrix-raised-cast12x80.txt 2>&1
echo done > $P/raw/run-ab.done
