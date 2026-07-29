UV ?= uv
PILOT_BATCH_SIZES ?= 4,8
PILOT_THREAD_COUNTS ?= physical,8
FINAL_BATCH_SIZE ?= 8
FINAL_THREAD_COUNT ?= physical
FINAL_BUCKET_MODE ?= bucketed
FINAL_IMPACT_CONTEXT ?= full
FINAL_CHECKPOINT ?= artifacts/early-gate/final.checkpoint.json
PHASE0B_MODEL ?= ja_xsmall
PHASE0B_PILOT_BATCH_SIZES ?= 4,8,16
PHASE0B_PILOT_THREAD_COUNTS ?= 4,physical,8
PHASE0B_FINAL_BATCH_SIZE ?= 8
PHASE0B_FINAL_THREAD_COUNT ?= physical
PHASE0B_FINAL_BUCKET_MODE ?= bucketed

.PHONY: sync-cpu test validate bootstrap smoke pilot early-gate contention bootstrap-rerankers reranker-pilot reranker-gate

sync-cpu:
	$(UV) sync --frozen --extra cpu

test:
	$(UV) run --frozen --extra cpu pytest

validate:
	$(UV) run --frozen --extra cpu python tools/validate_dataset.py data/public

bootstrap:
	$(UV) run --frozen --extra cpu python tools/bootstrap_model.py --config configs/common.yaml

smoke:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.train --config configs/relevance-1024.yaml --smoke

pilot:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.benchmark --config configs/benchmark-cpu.yaml --mode pilot --skip-length-sweep --batch-sizes $(PILOT_BATCH_SIZES) --thread-counts $(PILOT_THREAD_COUNTS) --bucket-modes naive,bucketed --impact-context-modes full

early-gate:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.benchmark --config configs/benchmark-cpu.yaml --mode early-gate --skip-length-sweep --batch-sizes $(FINAL_BATCH_SIZE) --thread-counts $(FINAL_THREAD_COUNT) --bucket-modes $(FINAL_BUCKET_MODE) --impact-context-modes $(FINAL_IMPACT_CONTEXT) --checkpoint $(FINAL_CHECKPOINT)

contention:
	node tools/host_contention_probe.mjs --config configs/benchmark-contention.yaml --output artifacts/contention.json

bootstrap-rerankers:
	$(UV) run --frozen --extra cpu python tools/bootstrap_rerankers.py --config configs/phase0b-rerankers.yaml

reranker-pilot:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.reranker_benchmark --config configs/phase0b-rerankers.yaml --model $(PHASE0B_MODEL) --mode pilot --batch-sizes $(PHASE0B_PILOT_BATCH_SIZES) --thread-counts $(PHASE0B_PILOT_THREAD_COUNTS) --bucket-modes naive,bucketed --skip-cold

reranker-gate:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.reranker_benchmark --config configs/phase0b-rerankers.yaml --model $(PHASE0B_MODEL) --mode early-gate --batch-sizes $(PHASE0B_FINAL_BATCH_SIZE) --thread-counts $(PHASE0B_FINAL_THREAD_COUNT) --bucket-modes $(PHASE0B_FINAL_BUCKET_MODE)
