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
#   5. electron-builder.yml の tokenizer wildcard に含まれることを検証
#      (int8 モデルは非同梱・オンデマンド DL: spec.rs の artifact_url/sha256 で
#       GitHub Release semantic-models-v1 から初回利用時に app_data へ取得)
#   6. 残りの手作業 (閾値の反映・golden test・build) を案内
#
# Usage:
#   bash scripts/setup-en-embedding.sh            # 既定: bge-small-en-v1.5 (SPEC_EN と一致)
#   bash scripts/setup-en-embedding.sh granite    # 代替: granite-small-en-r2
#
# bge は SPEC_EN (src-tauri/crates/grimodex-semantic/src/spec.rs) の既定値と一致する。
# granite を選んだ場合だけ model_id / dir_name / golden_fixture /
# needs_token_type_ids を書き換える必要がある（末尾に必要な差分を表示する）。

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

# ── 5. tokenizer の Electron bundle 契約を検証 ─────────────────────────────
# 埋め込みモデル (model_int8.onnx) は同梱しない。初回利用時に app_data へ
# オンデマンド DL する方式 (spec.rs の artifact_url/artifact_sha256 で
# GitHub Release semantic-models-v1 の資産を pin) に移行済み。ここで同梱
# リソースへ入れるのは git-tracked の tokenizer.json のみ。int8 モデルは別途
# GitHub Release にアップロードし spec.rs に sha256 を焼く (下記 手作業 5)。
echo "==> Verifying Electron tokenizer bundle contract for $DIR_NAME"
test -s "$OUT_DIR/tokenizer.json"
grep -Fq 'from: src-tauri/resources/semantic' electron-builder.yml
grep -Fq -- '- "**/tokenizer.json"' electron-builder.yml
echo "   electron-builder.yml includes every semantic tokenizer.json"

# ── 6. 次の手作業を案内 ───────────────────────────────────────────────────
RECOMMENDED="$(grep -oE 'RECOMMENDED SEMANTIC_RECALL_MIN_SCORE: [0-9.]+' /tmp/en-calibration-result.txt | grep -oE '[0-9.]+$' || echo '?')"
cat <<EOF

────────────────────────────────────────────────────────────────────────
DONE (export + golden + calibration + bundle verification). Remaining manual steps:

1. Set the English RAG threshold from the calibration above:
     src/features/chat/semanticRecall.ts
       export const SEMANTIC_RECALL_MIN_SCORE_EN = ${RECOMMENDED};

EOF

if [ "$MODEL_CHOICE" = "granite" ]; then
cat <<EOF
2. granite was chosen → update src-tauri/crates/grimodex-semantic/src/spec.rs SPEC_EN
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
     cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-semantic \
       --features semantic-embedding golden -- --nocapture
   Expect both ja (ruri) and en ($DIR_NAME) golden to pass.

4. Reindex an English project once in-app (semantic_reindex_all) so its
   scene_chunks are built with the en model, then check semantic search.

5. Upload $OUT_DIR/model_int8.onnx to the GitHub Release "semantic-models-v1"
   as "$DIR_NAME-model_int8.onnx", then pin its sha256 in
   src-tauri/crates/grimodex-semantic/src/spec.rs (artifact_url / artifact_sha256). The int8
   model is NOT bundled — it is downloaded on demand to app_data on first
   use and verified against the pinned sha256.

6. Release bundle sanity: pnpm electron:package:dir. electron-builder bundles
   only tokenizer.json files; the int8 model is fetched at runtime, not bundled.
────────────────────────────────────────────────────────────────────────
EOF
