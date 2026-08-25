# Narrative Semantic Core JSON Schemas

These schemas describe the machine-readable C1.5 and NIR-0 policy documents.
They are contract schemas only; they do not create persistence tables, connect
the Disclosure Policy to Retrieval, or wire the declared Scope V2 and
Dependency Role V2 contracts into production.

- `narrative-ir-contract.schema.json` validates the NIR-0 contract policy for
  Envelope V2, the Human-derived boundary, stale-validation split, Adapter
  golden binding, and disabled activation policy.
- The corresponding golden corpus lives at
  `../fixtures/narrative-ir/chronicle-scene-event-v2.json`; it is contract
  data and does not create persistence or runtime behavior.
- `narrative-dependency-producer-registry.schema.json` validates the bundled
  Rust Dependency Edge producer-generation registry. Its writer module and
  symbol fields are additionally checked against the compiled producer paths
  by the shared `grimodex-db` validator. The Proposal Revision entry also
  carries the numeric D1 `declarationSetGeneration` contract; its value is
  checked against the writer-owned Rust `i64` constant, while other producers
  remain without that field.
