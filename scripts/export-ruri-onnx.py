#!/usr/bin/env python3
"""
ruri-v3-30m (本家 cl-nagoya) を HuggingFace optimum 経由で ONNX に変換する。

目的: 第三者の ONNX 変換 (sirasagi62/ruri-v3-30m-ONNX) に依存せず、
      本家 PyTorch 重みから自分で変換した model.onnx と model_int8.onnx
      を src-tauri/resources/semantic/ruri-v3-30m/ に置く。
      Step 5 の golden test で cosine 一致を検証してから採用する想定。

設計: temp/semantic-prose-search-context.md §2.1〜§2.3。

Usage:
    python3 scripts/export-ruri-onnx.py [--revision SHA] [--output-dir PATH]
        [--skip-fp32] [--skip-int8]

Requirements (venv 推奨):
    pip install "optimum[onnxruntime]" sentencepiece protobuf

    - optimum[onnxruntime]: PyTorch → ONNX export + 量子化
    - sentencepiece: ruri-v3 の tokenizer (LlamaTokenizerFast / SentencePiece バックエンド) を
                     slow → fast 変換するのに必須。AutoTokenizer.from_pretrained が落ちる原因に
                     なるので忘れずに。
    - protobuf: SentencePiece の .model ファイル parse に使う。

挙動:
    1. cl-nagoya/ruri-v3-30m を `feature-extraction` task で ONNX export
       → model.onnx (fp32, ~150MB) + tokenizer.json + config 一式
    2. optimum の ORTQuantizer で int8 動的量子化
       → model_int8.onnx (~40MB)
    3. ファイル一覧と SHA-256 ハッシュを stderr に書く
       (将来 revision pin と整合性検証に使う)

注意:
    feature-extraction を使うのは、Rust 側 (src-tauri/src/semantic/embedding.rs)
    が mean pooling と L2 normalize を自前で実装しているため。SentenceTransformer
    の全パイプラインを ONNX に固める方式は本プロジェクトでは採らない (§2.2 で
    pooling と normalize の正しさを golden test で検証する設計のため)。
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

DEFAULT_MODEL_ID = "cl-nagoya/ruri-v3-30m"
DEFAULT_OUTPUT_DIR = Path("src-tauri/resources/semantic/ruri-v3-30m")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export_fp32(model_id: str, revision: str | None, out_dir: Path) -> Path:
    """Export feature-extraction ONNX (fp32) and save tokenizer files alongside.

    Returns the path to the produced model.onnx.
    """
    from optimum.onnxruntime import ORTModelForFeatureExtraction
    from transformers import AutoTokenizer

    sys.stderr.write(
        f"[export] loading & exporting {model_id} "
        f"(revision={revision or 'main'}) to ONNX...\n"
    )
    model = ORTModelForFeatureExtraction.from_pretrained(
        model_id,
        revision=revision,
        export=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)

    out_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)

    # optimum は通例 model.onnx で出すが、ファイル名揺れに備えて検出する。
    candidates = [out_dir / "model.onnx", out_dir / "decoder_model.onnx"]
    fp32 = next((p for p in candidates if p.exists()), None)
    if fp32 is None:
        any_onnx = list(out_dir.glob("*.onnx"))
        if not any_onnx:
            raise FileNotFoundError(
                f"optimum did not emit a *.onnx file in {out_dir}; got {list(out_dir.iterdir())}"
            )
        fp32 = any_onnx[0]
        # 正規名にリネームしておく (Rust 側 locate_models() が model.onnx を期待)
        renamed = out_dir / "model.onnx"
        if fp32 != renamed:
            sys.stderr.write(f"[export] renaming {fp32.name} -> model.onnx\n")
            fp32.rename(renamed)
            fp32 = renamed

    sys.stderr.write(f"[export] wrote fp32 ONNX: {fp32}\n")
    return fp32


def quantize_int8(out_dir: Path, source_onnx: Path) -> Path:
    """Dynamic int8 quantization. Cross-platform load; AVX2 で最適化されるが
    ARM 等でもロード可。"""
    from optimum.onnxruntime import ORTQuantizer
    from optimum.onnxruntime.configuration import AutoQuantizationConfig

    sys.stderr.write(f"[quantize] preparing dynamic int8 quantization of {source_onnx.name}...\n")
    quantizer = ORTQuantizer.from_pretrained(out_dir, file_name=source_onnx.name)
    qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=False)

    # optimum は出力名に suffix を付ける。"int8" → model_int8.onnx
    quantizer.quantize(save_dir=out_dir, quantization_config=qconfig, file_suffix="int8")

    quantized = out_dir / "model_int8.onnx"
    if not quantized.exists():
        # 想定外のファイル名で出た場合に拾う
        candidates = sorted(out_dir.glob("*_int8.onnx"))
        if not candidates:
            raise FileNotFoundError(
                f"int8 quantization did not produce *_int8.onnx in {out_dir}"
            )
        produced = candidates[0]
        sys.stderr.write(f"[quantize] renaming {produced.name} -> model_int8.onnx\n")
        produced.rename(quantized)

    sys.stderr.write(f"[quantize] wrote int8 ONNX: {quantized}\n")
    return quantized


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument(
        "--revision",
        default=None,
        help="Hugging Face revision (commit/branch/tag)。省略時 = main の最新。"
        " 本番採用時は commit SHA に pin することを推奨 (§2.3)。",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        type=Path,
        help=f"出力先ディレクトリ (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument("--skip-fp32", action="store_true", help="fp32 export をスキップ (既存を流用)")
    parser.add_argument("--skip-int8", action="store_true", help="int8 量子化をスキップ")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="出力先を一度空にしてから再生成する。途中で残った別 revision の "
        "ファイルが混ざるのを避けたいときに使う。",
    )
    args = parser.parse_args()

    try:
        import optimum.onnxruntime  # noqa: F401
        import sentencepiece  # noqa: F401  # ruri-v3 tokenizer (Llama/SentencePiece) に必須
        import transformers  # noqa: F401
    except ImportError as exc:
        sys.stderr.write(
            f"Missing dependency: {exc.name}.\n"
            "Install (venv 推奨):\n"
            "    python3 -m venv .venv && source .venv/bin/activate  (or .venv\\Scripts\\activate on Windows)\n"
            "    pip install 'optimum[onnxruntime]' sentencepiece protobuf\n"
        )
        return 1

    out_dir: Path = args.output_dir
    if args.clean and out_dir.exists():
        sys.stderr.write(f"[export] cleaning {out_dir}...\n")
        shutil.rmtree(out_dir)

    if args.skip_fp32:
        fp32 = out_dir / "model.onnx"
        if not fp32.exists():
            sys.stderr.write(
                f"--skip-fp32 was set but {fp32} does not exist; export anyway.\n"
            )
            fp32 = export_fp32(args.model_id, args.revision, out_dir)
    else:
        fp32 = export_fp32(args.model_id, args.revision, out_dir)

    if not args.skip_int8:
        quantize_int8(out_dir, fp32)

    sys.stderr.write("\n[export] artifact summary:\n")
    for path in sorted(out_dir.iterdir()):
        if path.is_file():
            sys.stderr.write(f"  {path.name:32}  {path.stat().st_size:>12} bytes")
            if path.suffix == ".onnx":
                sys.stderr.write(f"  sha256={sha256_of(path)}")
            sys.stderr.write("\n")

    # ONNX graph 入力名を表示する。Rust 側はモデルに合わせて feed する入力を
    # 決める必要がある: ruri / granite (ModernBERT) は input_ids + attention_mask
    # の 2 入力だが、bge / e5 (素の BERT) は token_type_ids を加えた 3 入力に
    # なる。採用判断 (どちらのモデルを使うか) の材料として明示する。
    int8 = out_dir / "model_int8.onnx"
    probe = int8 if int8.exists() else (out_dir / "model.onnx")
    if probe.exists():
        try:
            import onnx  # type: ignore

            graph = onnx.load(str(probe)).graph
            names = [i.name for i in graph.input]
            sys.stderr.write(f"\n[export] {probe.name} graph inputs: {names}\n")
            if "token_type_ids" in names:
                sys.stderr.write(
                    "[export] NOTE: this model expects token_type_ids — the Rust\n"
                    "         embedder must feed a zeros tensor for it (set\n"
                    "         EmbeddingModelSpec.needs_token_type_ids = true).\n"
                )
        except ImportError:
            sys.stderr.write(
                "\n[export] (install `onnx` to print graph input names)\n"
            )

    sys.stderr.write(
        "\n[export] done. Next: run `python3 scripts/generate-ruri-golden.py`,\n"
        "                  then `cargo test --lib semantic::embedding`.\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
