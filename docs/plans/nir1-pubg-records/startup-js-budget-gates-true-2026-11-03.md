# PUB-G の前提：gate を開けた build の起動時 JS の容量（2026-11-03）

PUB-G の前提の棚卸し（`pubg-prereq-inventory-2026-11-03.md` の #30）の実測。master `21c25c73` の使い捨ての worktree（detached）で、renderer の gate の定数だけを書き換えて `pnpm build` し、`node scripts/check-performance-budgets.mjs` を走らせた。commit はしていない（書き換えは測定の後に戻し、worktree は clean）。Native の `PRODUCT_GRAPH_PUBLISHED` は JS の容量に関わらないので変えていない。

| build | 開けた定数 | 起動時 JS の raw | gzip | 上限（raw 4,261,500／gzip 1,349,743） |
|---|---|---|---|---|
| 閉（今の製品） | なし | 4,261,445 | 1,346,500 | 内側（raw の余裕 55） |
| PUB-G | `NIR1_GRAPH_UI_ENABLED`、`BODY_DECLARATION_UI_ENABLED` | 4,261,445 | 1,346,555 | 内側（raw は同じ、gzip +55） |
| PUB-G＋D2a の UI | 上の 2 つ＋`PROFILE_ACTIVATION_UI_ENABLED` | 4,263,036 | 1,347,169 | **raw が 1,536 byte 超過**（gzip は内側） |

読み（integrator）：PUB-G の 2 つの定数は起動時の graph の raw を増やさない（gzip だけ +55）。D2a の activation UI の定数を開けると raw が +1,591 で上限を 1,536 超える。DR-DA2B-R25 の「定数 true で上限超え」は D2a の UI の分に当たる。対処は、memory の方針（`initial-graph-budget-relax-ok`：まず lazy 化、足りない分だけ最小限の緩和を独立 commit）で、Session C-1 で D2a の UI を開けるときに決める。値は 1 回の build の値（決定的な build なので揺れは小さい見込み、確かめていない）。
