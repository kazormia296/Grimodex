# Scenario format

Each JSON file validates against `../scenario.schema.json` and contains one
`statuses` and one `snapshots` entry for every semantic action. Adapters must
compare every snapshot field, including candidates, generation, UTF-8 caret,
effects, and final learning call counts; partial or scenario-specific skipping
is not conformance.

The v1 fake converter is deterministic:

- an ordinary conversion emits `変換` and a reading candidate;
- the initial active segment consumes at most two input elements;
- after `resize_segment`, the first candidate consumes the requested target;
- predictions are empty;
- `converter_fault: converter_throws` makes conversion fail before producing
  candidates.

Platform transport, renderer, key mapping, and recovery tests remain separate,
but must reference the same stable `scenario_id` where they cover a common
behavior.
