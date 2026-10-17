#!/bin/bash
cd /home/grimodex/worktrees/Grimodex/claude-nir1-measure/src-tauri
R=/tmp/claude-1000/-home-grimodex-Grimodex/fa34d6ef-ff00-4f4d-846d-7ccee58abf30/scratchpad/proposal7/r2
T=$R/test-candB-10s
for c in 0 600 2000; do
  if [ $c = 0 ]; then unset P7_SUMMARY_CHARS; else export P7_SUMMARY_CHARS=$c; fi
  P7_SHAPES=20:scene,30:scene,50:scene,100:scene P7_SEEDS=m1,m2,m3,m4,m5,c01 P7_REPS=1 P7_NO_REVSIZES=1 $T --ignored --nocapture --test-threads=1 p7_matrix > $R/candB-matrix-sum$c.txt 2>&1
done
unset P7_SUMMARY_CHARS
P7_CAST=8:40 P7_SEEDS=cast P7_SHAPES=50:scene,100:scene P7_REPS=1 P7_NO_REVSIZES=1 $T --ignored --nocapture --test-threads=1 p7_matrix > $R/candB-matrix-cast8x40.txt 2>&1
P7_CAST=12:80 P7_SEEDS=cast P7_SHAPES=50:scene,100:scene P7_REPS=1 P7_NO_REVSIZES=1 $T --ignored --nocapture --test-threads=1 p7_matrix > $R/candB-matrix-cast12x80.txt 2>&1
echo done > $R/candB-matrix.done
