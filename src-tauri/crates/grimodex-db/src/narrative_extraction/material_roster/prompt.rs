//! Exact chronicle.prompt/1 replay. Contract bytes are frozen from the TS
//! builders and checked against them by materialRosterReplay.test.ts.
use anyhow::{ensure, Result};
use grimodex_core::canonical_json_digest;
use serde::Serialize;
use serde_json::{json, Value};

pub(super) const OBSERVATION: &str = "narrative_observation_extract";
pub(super) const SYNTHESIS: &str = "narrative_event_synthesize";
const VERSION: &str = "chronicle.context-set/1";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Digests {
    pub context_set_digest: String,
    pub component_contract_digest: String,
    pub final_request_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestProof {
    pub execution_id: String,
    pub receipt_digest: String,
    pub reconstructed: Digests,
    pub persisted: Digests,
}

pub(super) fn contract(stage: &str) -> Result<Value> {
    let contracts: Value = serde_json::from_str(include_str!("contracts.json"))?;
    contracts
        .get(stage)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("unknown recipe"))
}

pub(super) fn contract_digest(stage: &str) -> Result<String> {
    Ok(canonical_json_digest(
        &json!({"schemaVersion":1,"contextSetVersion":VERSION,
        "stageId":stage,"componentContract":contract(stage)?}),
    )?)
}

/// IDs are unique. Match JS code-unit ordering, including astral characters.
pub(super) fn replay(stage: &str, mut inputs: Vec<(String, String, String)>) -> Result<Digests> {
    inputs.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    ensure!(
        inputs.windows(2).all(|p| p[0].0 != p[1].0),
        "duplicate context"
    );
    let refs: std::collections::BTreeSet<_> = inputs.iter().map(|i| &i.1).collect();
    ensure!(refs.len() == inputs.len(), "duplicate input ref");
    let entries: Vec<_> = inputs
        .iter()
        .map(|(id, r, _)| {
            json!({
        "contextId":id,"inputRef":r,"stageId":stage,"exposure":"model-visible",
        "selector":{"kind":"whole-source"}})
        })
        .collect();
    let context_set_digest = canonical_json_digest(&json!({"version":VERSION,"entries":entries}))?;
    let component_contract_digest = contract_digest(stage)?;
    let c = contract(stage)?;
    let sections = if inputs.is_empty() {
        "(no model-visible context)".into()
    } else {
        inputs
            .iter()
            .map(|(id, r, v)| format!("--- contextId={id} inputRef={r} ---\n{v}"))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let content = format!(
        "{}\n\n# Context Set (chronicle.prompt/1)\n{}\n\n# Output (JSON only)\n{}",
        super::string_at(&c, "/instruction")?,
        sections,
        super::string_at(&c, "/outputShape")?
    );
    let final_request_digest = canonical_json_digest(&json!({"schemaVersion":1,
        "contextSetVersion":VERSION,"stageId":stage,"contextSetDigest":context_set_digest,
        "componentContractDigest":component_contract_digest,"messages":[{"role":"user","content":content}]}))?;
    Ok(Digests {
        context_set_digest,
        component_contract_digest,
        final_request_digest,
    })
}

pub(super) fn proof(receipt: &Value, reconstructed: Digests) -> Result<RequestProof> {
    let persisted = Digests {
        context_set_digest: super::string_at(receipt, "/contextSetDigest")?,
        component_contract_digest: super::string_at(receipt, "/componentContractDigest")?,
        final_request_digest: super::string_at(receipt, "/finalRequestDigest")?,
    };
    ensure!(reconstructed == persisted, "request-digest-mismatch");
    Ok(RequestProof {
        execution_id: super::string_at(receipt, "/stageExecution/stageExecutionId")?,
        receipt_digest: super::string_at(receipt, "/stageExecutionReceiptDigest")?,
        reconstructed,
        persisted,
    })
}

pub(super) fn synthesis(cluster: &str, observations: &[Value]) -> Result<Digests> {
    let mut inputs = vec![(
        format!("event-cluster:{cluster}"),
        format!("cluster:{cluster}"),
        cluster.to_owned(),
    )];
    for o in observations {
        let id = super::string_at(o, "/localId")?;
        let quotes = super::array_at(o, "/evidence")?
            .iter()
            .map(|e| {
                Ok(format!(
                    "{}:{}",
                    super::string_at(e, "/sourceRef")?,
                    super::string_at(e, "/quote")?
                ))
            })
            .collect::<Result<Vec<_>>>()?
            .join(" | ");
        let row = format!(
            "- localId={id}; actuality={}; predicate={}; evidence={quotes}",
            super::string_at(o, "/payload/actuality")?,
            super::string_at(o, "/payload/predicate")?
        );
        inputs.push((
            format!("event-observation:{id}"),
            format!("observation:{id}"),
            row,
        ));
    }
    replay(SYNTHESIS, inputs)
}
