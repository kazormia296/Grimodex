//! Closed production route registry for automatic Narrative Maintenance.
//!
//! The persisted Run Kind and the product-facing route ID are intentionally
//! separate identities.  The former is a database compatibility value while
//! the latter is the stable policy route.  Keeping the dispatch adapters in
//! this table makes the automatic surface a closed set without requiring a
//! source-code call-graph scan.

use crate::narrative_extraction::maintenance_contracts::MaintenanceContractCoordinates;
use crate::narrative_extraction::maintenance_runtime::{
    AutomaticRunKind, DesiredWork, MaintenanceCycleControl,
};
use crate::Database;

/// Version of the native automatic maintenance route registry contract.
pub const NARRATIVE_MAINTENANCE_ROUTE_REGISTRY_VERSION: &str = "narrative-maintenance-route/v1";

/// Read-only metadata for one automatic maintenance route.
///
/// The dispatch function is deliberately not part of this public descriptor:
/// callers can inspect the closed route mapping but cannot invoke an adapter
/// without going through the production cycle owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaintenanceRouteDescriptor {
    pub route_id: &'static str,
    pub run_kind: AutomaticRunKind,
}

type DispatchAdapter = for<'a> fn(
    &Database,
    &DesiredWork,
    Option<&MaintenanceContractCoordinates>,
    Option<&MaintenanceCycleControl<'a>>,
) -> anyhow::Result<()>;

#[derive(Clone, Copy)]
struct RouteEntry {
    descriptor: MaintenanceRouteDescriptor,
    dispatch: DispatchAdapter,
}

const ROUTE_DESCRIPTORS: [MaintenanceRouteDescriptor; 3] = [
    MaintenanceRouteDescriptor {
        route_id: "dependency-backfill",
        run_kind: AutomaticRunKind::Backfill,
    },
    MaintenanceRouteDescriptor {
        route_id: "dependency-verify",
        run_kind: AutomaticRunKind::Verify,
    },
    MaintenanceRouteDescriptor {
        route_id: "dependency-rebuild-derived",
        run_kind: AutomaticRunKind::RebuildDerived,
    },
];

const ROUTE_REGISTRY: [RouteEntry; 3] = [
    RouteEntry {
        descriptor: ROUTE_DESCRIPTORS[0],
        dispatch: dispatch_backfill,
    },
    RouteEntry {
        descriptor: ROUTE_DESCRIPTORS[1],
        dispatch: dispatch_verify,
    },
    RouteEntry {
        descriptor: ROUTE_DESCRIPTORS[2],
        dispatch: dispatch_rebuild_derived,
    },
];

/// Return the complete closed route set for policy parity checks.
pub fn route_descriptors() -> &'static [MaintenanceRouteDescriptor] {
    &ROUTE_DESCRIPTORS
}

/// Return the descriptor for one automatic kind, if it is registered.
pub fn route_descriptor_for_run_kind(
    run_kind: AutomaticRunKind,
) -> Option<MaintenanceRouteDescriptor> {
    ROUTE_REGISTRY
        .iter()
        .find(|entry| entry.descriptor.run_kind == run_kind)
        .map(|entry| entry.descriptor)
}

/// Return the descriptor for a stable route ID, if it is registered.
pub fn route_descriptor_by_id(route_id: &str) -> Option<MaintenanceRouteDescriptor> {
    ROUTE_REGISTRY
        .iter()
        .find(|entry| entry.descriptor.route_id == route_id)
        .map(|entry| entry.descriptor)
}

/// Return the stable route ID for an automatic kind.
pub fn route_id_for_run_kind(run_kind: AutomaticRunKind) -> Option<&'static str> {
    route_descriptor_for_run_kind(run_kind).map(|descriptor| descriptor.route_id)
}

/// Dispatch one validated work item through its registered production adapter.
pub(crate) fn dispatch_enabled_work(
    db: &Database,
    item: &DesiredWork,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<()> {
    let entry = ROUTE_REGISTRY
        .iter()
        .find(|entry| entry.descriptor.run_kind == item.run_kind)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_ROUTE_UNREGISTERED: no production route for {:?}",
                item.run_kind
            )
        })?;
    (entry.dispatch)(db, item, coordinates, control)
}

fn dispatch_backfill(
    db: &Database,
    item: &DesiredWork,
    _coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<()> {
    super::bootstrap_legacy_dependency_backfill_for_project_with_control(
        db,
        &item.project_id,
        control,
        &item.canonical_key(),
    )?;
    Ok(())
}

fn dispatch_verify(
    db: &Database,
    item: &DesiredWork,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<()> {
    super::restore_rebuild::run_dependency_verify_for_project_with_coordinates_and_control(
        db,
        &item.project_id,
        coordinates,
        control,
        &item.canonical_key(),
    )?;
    Ok(())
}

fn dispatch_rebuild_derived(
    db: &Database,
    item: &DesiredWork,
    _coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<()> {
    match super::restore_rebuild::rebuild_narrative_derived_state_for_project_with_control(
        db,
        &item.project_id,
        control,
        &item.canonical_key(),
    )? {
        super::restore_rebuild::RebuildDerivedStateOutcome::AlreadyRunning { .. }
        | super::restore_rebuild::RebuildDerivedStateOutcome::Ran { .. } => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_the_exact_closed_set_with_stable_route_ids() {
        assert_eq!(
            NARRATIVE_MAINTENANCE_ROUTE_REGISTRY_VERSION,
            "narrative-maintenance-route/v1"
        );
        assert_eq!(
            route_descriptors(),
            &[
                MaintenanceRouteDescriptor {
                    route_id: "dependency-backfill",
                    run_kind: AutomaticRunKind::Backfill,
                },
                MaintenanceRouteDescriptor {
                    route_id: "dependency-verify",
                    run_kind: AutomaticRunKind::Verify,
                },
                MaintenanceRouteDescriptor {
                    route_id: "dependency-rebuild-derived",
                    run_kind: AutomaticRunKind::RebuildDerived,
                },
            ]
        );
        assert!(route_descriptor_by_id("dependency-repair").is_none());
        assert!(route_descriptor_by_id("incremental-freshness").is_none());
        assert_eq!(AutomaticRunKind::Backfill.route_id(), "dependency-backfill");
        assert_eq!(AutomaticRunKind::Verify.route_id(), "dependency-verify");
        assert_eq!(
            AutomaticRunKind::RebuildDerived.route_id(),
            "dependency-rebuild-derived"
        );
    }

    #[test]
    fn descriptors_round_trip_by_kind_and_stable_id() {
        for &expected in route_descriptors() {
            assert_eq!(
                route_descriptor_for_run_kind(expected.run_kind),
                Some(expected)
            );
            assert_eq!(route_descriptor_by_id(expected.route_id), Some(expected));
            assert_eq!(
                route_id_for_run_kind(expected.run_kind),
                Some(expected.route_id)
            );
        }
    }
}
