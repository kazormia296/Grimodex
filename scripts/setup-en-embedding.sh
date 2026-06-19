#!/usr/bin/env bash
#
# 英語 embedding モデルをホストでセットアップする one-shot スクリプト。
#
# このスクリプトは **ホスト** (ort がリンクでき、HuggingFace に到達でき、pip が
# 使える開発機) で実行する。devcontainer では (a) pypi が firewall 許可外、
# (b) pip 不在、(c) ort が glibc symbol mismatch でリンク失敗、の 3 点で
# モデル export・推論検証ができないため。
#
# やること:
#   1. venv を作り optimum / sentence-transformers / onnx を入れる
#   2. 選択モデルを ONNX (int8) に export → src-tauri/resources/semantic/<dir>/
#   3. golden fixture を生成 → src-tauri/tests/fixtures/<fixture>.json
#   4. RAG スコア閾値をキャリブレーション (推奨 min_score を表示)
#   5. tauri.conf.json / tauri.release.conf.json の bundle.resources に en モデルを追記
#   6. 残りの手作業 (閾値の反映・golden test・build) を案内
#
# Usage:
#   bash scripts/setup-en-embedding.sh            # 既定: granite (SPEC_EN と一致)
#   bash scripts/setup-en-embedding.sh bge        # 代替: bge-small-en-v1.5
#
# bge を選んだ場合は SPEC_EN (src-tauri/src/semantic/spec.rs) の model_id /
# dir_name / golden_fixture / needs_token_type_ids を bge 用に書き換える必要が
# ある (スクリプト末尾に必要な差分を表示する)。granite は SPEC_EN の既定値と
# 一致するのでコード変更不要。

set -euo pipefail

# 既定は bge: ホスト calibration で granite に勝ち SPEC_EN に採用済み。
# granite を試したい場合のみ引数で指定 (その場合 SPEC_EN の編集が要る)。
MODEL_CHOICE="${1:-bge}"

case "$MODEL_CHOICE" in
  granite)
    MODEL_ID="ibm-granite/granite-embedding-small-english-r2"
    DIR_NAME="granite-small-en-r2"
    FIXTURE="granite_small_en_r2_golden.json"
    NEEDS_TTI="false"
    ;;
  bge)
    MODEL_ID="BAAI/bge-small-en-v1.5"
    DIR_NAME="bge-small-en-v15"
    FIXTURE="bge_small_en_v15_golden.json"
    NEEDS_TTI="true"
    ;;
  *)
    echo "Unknown model '$MODEL_CHOICE' (expected: granite | bge)" >&2
    exit 1
    ;;
esac

# リポジトリルートへ移動 (このスクリプトは scripts/ にある前提)。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="src-tauri/resources/semantic/$DIR_NAME"
FIXTURE_PATH="src-tauri/tests/fixtures/$FIXTURE"
VENV_DIR=".venv-en-embedding"

echo "==> Model: $MODEL_ID"
echo "==> Output dir: $OUT_DIR"
echo "==> Fixture: $FIXTURE_PATH"
echo

# ── 1. venv + deps ────────────────────────────────────────────────────────
if [ ! -d "$VENV_DIR" ]; then
  echo "==> Creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
echo "==> Installing Python deps (optimum / sentence-transformers / onnx)"
pip install --quiet --upgrade pip
pip install --quiet "optimum[onnxruntime]" sentence-transformers onnx sentencepiece protobuf

# ── 2. ONNX export ────────────────────────────────────────────────────────
echo "==> Exporting $MODEL_ID to ONNX (int8)"
python3 scripts/export-ruri-onnx.py --model-id "$MODEL_ID" --output-dir "$OUT_DIR"

# ── 3. golden fixture ─────────────────────────────────────────────────────
echo "==> Generating golden fixture (English samples, prefix-free)"
python3 scripts/generate-ruri-golden.py --lang en --model-id "$MODEL_ID" --out "$FIXTURE_PATH"

# ── 4. threshold calibration ──────────────────────────────────────────────
echo "==> Calibrating RAG score threshold"
python3 scripts/calibrate-embedding-threshold.py \
  --model-id "$MODEL_ID" \
  --inputs scripts/fixtures/en-calibration.jsonl | tee /tmp/en-calibration-result.txt

# ── 5. tauri bundle.resources 追記 (idempotent) ───────────────────────────
echo "==> Adding bundle resources for $DIR_NAME to tauri confs"
python3 - "$DIR_NAME" <<'PY'
import json, sys
dir_name = sys.argv[1]
edits = {
    "src-tauri/tauri.conf.json": [f"resources/semantic/{dir_name}/tokenizer.json"],
    "src-tauri/tauri.release.conf.json": [
        f"resources/semantic/{dir_name}/model_int8.onnx",
        f"resources/semantic/{dir_name}/tokenizer.json",
    ],
}
for path, entries in edits.items():
    with open(path, encoding="utf-8") as f:
        conf = json.load(f)
    res = conf.setdefault("bundle", {}).setdefault("resources", [])
    changed = False
    for e in entries:
        if e not in res:
            res.append(e)
            changed = True
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"   updated {path}")
    else:
        print(f"   {path} already has the entries")
PY

# ── 6. 次の手作業を案内 ───────────────────────────────────────────────────
RECOMMENDED="$(grep -oE 'RECOMMENDED SEMANTIC_RECALL_MIN_SCORE: [0-9.]+' /tmp/en-calibration-result.txt | grep -oE '[0-9.]+$' || echo '?')"
cat <<EOF

────────────────────────────────────────────────────────────────────────
DONE (export + golden + calibration + conf). Remaining manual steps:

1. Set the English RAG threshold from the calibration above:
     src/features/chat/semanticRecall.ts
       export const SEMANTIC_RECALL_MIN_SCORE_EN = ${RECOMMENDED};

EOF

if [ "$MODEL_CHOICE" = "granite" ]; then
cat <<EOF
2. granite was chosen → update src-tauri/src/semantic/spec.rs SPEC_EN
   (bge is the committed default, so granite requires these edits):
       model_id: "$MODEL_ID",
       dir_name: "$DIR_NAME",
       embedding_dim: 384,
       pooling: Pooling::Cls,                // granite ST config is cls
       needs_token_type_ids: $NEEDS_TTI,     // granite is ModernBERT (2 inputs)
       golden_fixture: "$FIXTURE",

EOF
else
cat <<EOF
2. bge matches the committed SPEC_EN default — no spec.rs change needed.

EOF
fi

cat <<EOF
3. Verify the Rust golden pipeline (host, ort links here):
     cd src-tauri && cargo test --features semantic-embedding semantic::embedding::golden -- --nocapture
   Expect both ja (ruri) and en ($DIR_NAME) golden to pass.

4. Reindex an English project once in-app (semantic_reindex_all) so its
   scene_chunks are built with the en model, then check semantic search.

5. Release build sanity: pnpm tauri build (confirms the bundled en model).
────────────────────────────────────────────────────────────────────────
EOF
