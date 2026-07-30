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
PHASE0B_GATE2_CANDIDATES ?= data/public/gate2/candidates-ja.jsonl
PHASE0B_GATE2_CHUNK_QRELS ?= data/public/gate2/chunk-qrels.json
PHASE0B_GATE2_PAIRS ?= data/public/gate2/parity-pairs-ja.jsonl
PHASE0B_GATE2_THREADS ?= 4
PHASE0B_GATE2_BATCH_SIZE ?= 4
PHASE0B_GATE2_PARITY_OUTPUT ?= artifacts/phase0b/gate2/parity-$(PHASE0B_MODEL).json
PHASE0B_GATE2_OUTPUT ?= artifacts/phase0b/gate2/final-$(PHASE0B_MODEL).json
IMPACT_GATE3_MODEL ?= ja_xsmall
IMPACT_GATE3_PILOT_BATCH_SIZES ?= 1,2,4,8
IMPACT_GATE3_PILOT_THREAD_COUNTS ?= 1,2,4,physical,8
IMPACT_GATE3_PILOT_BUCKET_MODES ?= naive,bucketed
IMPACT_GATE3_FINAL_BATCH_SIZE ?= 4
IMPACT_GATE3_FINAL_THREAD_COUNT ?= physical
IMPACT_GATE3_FINAL_BUCKET_MODE ?= bucketed
IMPACT_GATE3_PILOT_OUTPUT ?= artifacts/phase0b/gate3/pilot-$(IMPACT_GATE3_MODEL).json
IMPACT_GATE3_OUTPUT ?= artifacts/phase0b/gate3/final-$(IMPACT_GATE3_MODEL).json
IMPACT_GATE31_MODEL ?= ja_xsmall
IMPACT_GATE31_PILOT_BATCH_SIZES ?= 1,2,4,8
IMPACT_GATE31_PILOT_THREAD_COUNTS ?= 1,2,4,physical,8
IMPACT_GATE31_PILOT_BUCKET_MODES ?= naive,bucketed
IMPACT_GATE31_FINAL_BATCH_SIZE ?= 4
IMPACT_GATE31_FINAL_THREAD_COUNT ?= physical
IMPACT_GATE31_FINAL_BUCKET_MODE ?= bucketed
IMPACT_GATE31_PILOT_OUTPUT ?= artifacts/phase0b/gate31/pilot-$(IMPACT_GATE31_MODEL).json
IMPACT_GATE31_OUTPUT ?= artifacts/phase0b/gate31/final-$(IMPACT_GATE31_MODEL).json

.PHONY: sync-cpu test validate bootstrap smoke pilot early-gate contention bootstrap-rerankers bootstrap-reranker-references reranker-pilot reranker-gate reranker-parity reranker-gate2 bootstrap-impact-gate3 impact-gate3-pilot impact-gate3 impact-gate31-pilot impact-gate31

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

bootstrap-reranker-references:
	$(UV) run --frozen --extra cpu python tools/bootstrap_reranker_references.py --config configs/phase0b-rerankers.yaml

reranker-pilot:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.reranker_benchmark --config configs/phase0b-rerankers.yaml --model $(PHASE0B_MODEL) --mode pilot --batch-sizes $(PHASE0B_PILOT_BATCH_SIZES) --thread-counts $(PHASE0B_PILOT_THREAD_COUNTS) --bucket-modes naive,bucketed --skip-cold

reranker-gate:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.reranker_benchmark --config configs/phase0b-rerankers.yaml --model $(PHASE0B_MODEL) --mode early-gate --batch-sizes $(PHASE0B_FINAL_BATCH_SIZE) --thread-counts $(PHASE0B_FINAL_THREAD_COUNT) --bucket-modes $(PHASE0B_FINAL_BUCKET_MODE)

reranker-parity:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.reranker_parity --config configs/phase0b-rerankers.yaml --candidates $(PHASE0B_GATE2_CANDIDATES) --pairs $(PHASE0B_GATE2_PAIRS) --model $(PHASE0B_MODEL) --threads $(PHASE0B_GATE2_THREADS) --output $(PHASE0B_GATE2_PARITY_OUTPUT)

reranker-gate2:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.reranker_gate2_runner --config configs/phase0b-rerankers.yaml --candidates $(PHASE0B_GATE2_CANDIDATES) --chunk-qrels $(PHASE0B_GATE2_CHUNK_QRELS) --model $(PHASE0B_MODEL) --threads $(PHASE0B_GATE2_THREADS) --batch-size $(PHASE0B_GATE2_BATCH_SIZE) --output $(PHASE0B_GATE2_OUTPUT)

bootstrap-impact-gate3:
	$(UV) run --frozen --extra cpu python tools/bootstrap_impact_gate3.py --config configs/phase0b-impact-gate3.yaml

impact-gate3-pilot:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.impact_gate3_benchmark --config configs/phase0b-impact-gate3.yaml --model $(IMPACT_GATE3_MODEL) --mode pilot --batch-sizes $(IMPACT_GATE3_PILOT_BATCH_SIZES) --thread-counts $(IMPACT_GATE3_PILOT_THREAD_COUNTS) --bucket-modes $(IMPACT_GATE3_PILOT_BUCKET_MODES) --skip-cold --output $(IMPACT_GATE3_PILOT_OUTPUT)

impact-gate3:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.impact_gate3_benchmark --config configs/phase0b-impact-gate3.yaml --model $(IMPACT_GATE3_MODEL) --mode early-gate --batch-sizes $(IMPACT_GATE3_FINAL_BATCH_SIZE) --thread-counts $(IMPACT_GATE3_FINAL_THREAD_COUNT) --bucket-modes $(IMPACT_GATE3_FINAL_BUCKET_MODE) --output $(IMPACT_GATE3_OUTPUT)

impact-gate31-pilot:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.impact_gate31_benchmark --config configs/phase0b-impact-gate31.yaml --model $(IMPACT_GATE31_MODEL) --mode pilot --batch-sizes $(IMPACT_GATE31_PILOT_BATCH_SIZES) --thread-counts $(IMPACT_GATE31_PILOT_THREAD_COUNTS) --bucket-modes $(IMPACT_GATE31_PILOT_BUCKET_MODES) --pilot-repetitions 1 --output $(IMPACT_GATE31_PILOT_OUTPUT)

impact-gate31:
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 $(UV) run --frozen --extra cpu python -m grimodex_lfm_eval.impact_gate31_benchmark --config configs/phase0b-impact-gate31.yaml --model $(IMPACT_GATE31_MODEL) --mode early-gate --batch-sizes $(IMPACT_GATE31_FINAL_BATCH_SIZE) --thread-counts $(IMPACT_GATE31_FINAL_THREAD_COUNT) --bucket-modes $(IMPACT_GATE31_FINAL_BUCKET_MODE) --output $(IMPACT_GATE31_OUTPUT)
