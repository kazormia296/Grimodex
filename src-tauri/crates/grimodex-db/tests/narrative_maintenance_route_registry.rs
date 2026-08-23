//! Contract parity between the canonical Run Kind policy and the native route registry.

use grimodex_db::narrative_extraction::maintenance_route_registry::{
    route_descriptor_by_id, route_descriptors, NARRATIVE_MAINTENANCE_ROUTE_REGISTRY_VERSION,
};
use serde::Deserialize;
use std::collections::BTreeSet;

const POLICY_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../policies/narrative/narrative-run-kind-policy.json"
));
const SHARED_PRODUCTION_ENTRY_POINT: &str = "run_narrative_maintenance_cycle";

#[derive(Debug, Deserialize)]
struct RunKindPolicy {
    #[serde(rename = "runKinds")]
    run_kinds: Vec<PolicyRunKind>,
}

#[derive(Debug, Deserialize)]
struct PolicyRunKind {
    #[serde(rename = "runKind")]
    run_kind: String,
    #[serde(rename = "existingRunKindColumnValue")]
    existing_run_kind_column_value: Option<String>,
    trigger: String,
    #[serde(rename = "runtimeRoute")]
    runtime_route: Option<RuntimeRoute>,
    #[serde(rename = "implementationStatus")]
    implementation_status: ImplementationStatus,
}

#[derive(Debug, Deserialize)]
struct RuntimeRoute {
    #[serde(rename = "registryVersion")]
    registry_version: String,
    #[serde(rename = "routeId")]
    route_id: String,
    #[serde(rename = "productionEntryPoint")]
    production_entry_point: String,
}

#[derive(Debug, Deserialize)]
struct ImplementationStatus {
    state: String,
    #[serde(rename = "productionEntryPoints")]
    production_entry_points: Vec<String>,
}

#[test]
fn canonical_policy_matches_the_closed_typed_route_registry() {
    let policy: RunKindPolicy =
        serde_json::from_str(POLICY_JSON).expect("canonical narrative Run Kind policy must parse");
    let mut policy_routes = BTreeSet::new();
    let mut policy_route_ids = BTreeSet::new();
    let mut policy_run_kinds = BTreeSet::new();

    for entry in &policy.run_kinds {
        let Some(runtime_route) = &entry.runtime_route else {
            assert!(
                route_descriptor_by_id(&entry.run_kind).is_none(),
                "policy Run Kind {:?} has no runtimeRoute but is exposed by the typed registry",
                entry.run_kind
            );
            continue;
        };

        assert!(
            entry.trigger.starts_with("automatic-"),
            "policy runtime route {:?} must belong to an automatic trigger, got {:?}",
            runtime_route.route_id,
            entry.trigger
        );
        assert_eq!(
            entry.implementation_status.state, "wired",
            "policy runtime route {:?} must be wired before entering the native registry",
            runtime_route.route_id
        );
        assert_eq!(
            entry.run_kind, runtime_route.route_id,
            "policy runtimeRoute.routeId must identify its runKind"
        );
        assert_eq!(
            runtime_route.registry_version, NARRATIVE_MAINTENANCE_ROUTE_REGISTRY_VERSION,
            "policy runtime route {:?} has a stale registry version",
            runtime_route.route_id
        );
        assert_eq!(
            runtime_route.production_entry_point, SHARED_PRODUCTION_ENTRY_POINT,
            "policy runtime route {:?} must use the shared production cycle",
            runtime_route.route_id
        );
        assert_eq!(
            entry.implementation_status.production_entry_points,
            vec![SHARED_PRODUCTION_ENTRY_POINT.to_owned()],
            "policy implementation status for {:?} must expose only the shared production cycle",
            runtime_route.route_id
        );

        assert!(
            policy_route_ids.insert(runtime_route.route_id.clone()),
            "canonical policy contains duplicate runtimeRoute.routeId {:?}",
            runtime_route.route_id
        );
        assert!(
            policy_run_kinds.insert(entry.run_kind.clone()),
            "canonical policy contains duplicate automatic runKind {:?}",
            entry.run_kind
        );

        let descriptor = route_descriptor_by_id(&runtime_route.route_id).unwrap_or_else(|| {
            panic!(
                "canonical policy route {:?} is missing from the typed registry",
                runtime_route.route_id
            )
        });
        assert_eq!(
            descriptor.run_kind.route_id(),
            entry.run_kind,
            "typed route {:?} maps to a different policy runKind",
            runtime_route.route_id
        );
        let policy_persisted_run_kind = entry
            .existing_run_kind_column_value
            .as_deref()
            .unwrap_or(&entry.run_kind);
        assert_eq!(
            descriptor.run_kind.as_str(),
            policy_persisted_run_kind,
            "typed route {:?} has a different persisted Run Kind than policy",
            runtime_route.route_id
        );
        assert!(
            policy_routes.insert((
                runtime_route.route_id.clone(),
                policy_persisted_run_kind.to_owned()
            )),
            "canonical policy contains duplicate route/kind pair for {:?}",
            runtime_route.route_id
        );
    }

    let descriptors = route_descriptors();
    let mut typed_routes = BTreeSet::new();
    let mut typed_route_ids = BTreeSet::new();
    let mut typed_run_kinds = BTreeSet::new();
    for descriptor in descriptors {
        assert!(
            typed_route_ids.insert(descriptor.route_id),
            "typed registry contains duplicate route ID {:?}",
            descriptor.route_id
        );
        assert!(
            typed_run_kinds.insert(descriptor.run_kind.as_str()),
            "typed registry contains duplicate persisted Run Kind {:?}",
            descriptor.run_kind.as_str()
        );
        assert!(
            typed_routes.insert((
                descriptor.route_id.to_owned(),
                descriptor.run_kind.as_str().to_owned()
            )),
            "typed registry contains duplicate route/kind pair for {:?}",
            descriptor.route_id
        );
    }

    assert_eq!(
        policy_routes.len(),
        3,
        "canonical policy must contain exactly three automatic wired runtime routes; found {:?}",
        policy_routes
    );
    assert_eq!(
        descriptors.len(),
        3,
        "typed registry must contain exactly three automatic routes; found {:?}",
        typed_routes
    );
    assert_eq!(
        policy_routes, typed_routes,
        "automatic policy runtimeRoute set must exactly match the typed registry (missing or extra route/kind)",
    );
    assert!(
        route_descriptor_by_id("dependency-repair").is_none(),
        "manual dependency-repair must remain absent from automatic registry routes"
    );
    assert!(
        route_descriptor_by_id("incremental-freshness").is_none(),
        "change-feed incremental-freshness must remain absent from automatic registry routes"
    );
}
