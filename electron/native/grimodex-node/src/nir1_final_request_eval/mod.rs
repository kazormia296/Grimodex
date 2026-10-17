//! Evaluation-only final-request capture and baseline arm (DP-H, K6/2
//! `nir1-final-request-packing-eval`).
//!
//! This module exists only under the `nir1-final-request-eval` cargo feature.
//! The feature is never in `default`, is never enabled by the normal N-API
//! build or release packaging, and enables only the grimodex-db feature of the
//! same name. The harness is `cargo test`: no bin is added and `crate-type`
//! is unchanged. Nothing here is reachable from `#[napi]`, the IPC contract or
//! the preload; the module is declared as a child of `nir1_prepared_request`
//! (the renderer it calls and the value it observes are private to that
//! module) and the product path has exactly one call statement into it: the
//! (c-2) site after `render_local_plain_chat_payload` in
//! `prepare_local_chat_request_inner`.
//!
//! - `capture`: the (c-2) observation, the pairing of (c-1), (c-2) and the
//!   D-final return value per request, and the receipt JSON of a request.
//! - `baseline`: the P-12 baseline arm (selection only; rendering goes through
//!   the same renderer entry as the candidate).
//! - `receipt`: the guarded writer of a receipt file under `.artifacts/`.

mod baseline;
mod capture;
mod receipt;
#[cfg(test)]
mod tests;

#[allow(unused_imports)] // The harness (DPH-4) uses the whole surface.
pub(crate) use baseline::{
    run_baseline_arm, select_context_items, BaselineOutcome, BaselineRefused, BaselineResult,
    Selection, SelectionItem, MEASURE,
};
pub(super) use capture::observe_rendered;
#[allow(unused_imports)]
pub(crate) use capture::{
    run_dfinal_with_capture, CapturedRequest, DfinalOutcome, EvalRequestRecord,
};
#[allow(unused_imports)]
pub(crate) use receipt::write_json_file;
