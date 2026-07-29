UV ?= uv
PILOT_BATCH_SIZES ?= 4,8
PILOT_THREAD_COUNTS ?= physical,8
FINAL_BATCH_SIZE ?= 8
FINAL_THREAD_COUNT ?= physical
FINAL_BUCKET_MODE ?= bucketed
FINAL_IMPACT_CONTEXT ?= full
FINAL_CHECKPOINT ?= artifacts/early-gate/final.checkpoint.json

.PHONY: sync-cpu test validate bootstrap smoke pilot early-gate contention

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
