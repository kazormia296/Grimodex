//! Closed production route registry for automatic Narrative Maintenance.
//!
//! The persisted Run Kind and the product-facing route ID are intentionally
//! separate identities.  The former is a database compatibility value while
//! the latter is the stable policy route.  Keeping the dispatch adapters in
//! this table makes the automatic surface a closed set without requiring a
//! source-code call-graph scan.

use crate::narrative_extraction::maintenance_contracts::MaintenanceContractCoordinates;
use crate::narrative_extraction::maintenance_runtime::{
    foreground_system_work_barrier_requested, AutomaticRunKind, DesiredWork,
    MaintenanceCycleControl, MaintenanceDispatchOutcome,
};
use crate::Database;
use rusqlite::OptionalExtension;

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
) -> anyhow::Result<MaintenanceDispatchOutcome>;

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
) -> anyhow::Result<MaintenanceDispatchOutcome> {
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
) -> anyhow::Result<MaintenanceDispatchOutcome> {
    let outcome = super::bootstrap_legacy_dependency_backfill_for_project_with_control(
        db,
        &item.project_id,
        control,
        &item.canonical_key(),
    )?;
    let run_id = match outcome {
        super::LegacyBackfillBootstrapOutcome::AlreadyRun { run_id }
        | super::LegacyBackfillBootstrapOutcome::Ran { run_id, .. } => run_id,
    };
    foreground_dispatch_outcome(db, &run_id, control)
}

fn dispatch_verify(
    db: &Database,
    item: &DesiredWork,
    coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<MaintenanceDispatchOutcome> {
    let outcome =
        super::restore_rebuild::run_dependency_verify_for_project_with_coordinates_and_control(
            db,
            &item.project_id,
            coordinates,
            control,
            &item.canonical_key(),
        )?;
    foreground_dispatch_outcome(db, &outcome.run_id, control)
}

fn dispatch_rebuild_derived(
    db: &Database,
    item: &DesiredWork,
    _coordinates: Option<&MaintenanceContractCoordinates>,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<MaintenanceDispatchOutcome> {
    let outcome = super::restore_rebuild::rebuild_narrative_derived_state_for_project_with_control(
        db,
        &item.project_id,
        control,
        &item.canonical_key(),
    )?;
    let run_id = match outcome {
        super::restore_rebuild::RebuildDerivedStateOutcome::AlreadyRunning { run_id }
        | super::restore_rebuild::RebuildDerivedStateOutcome::Ran { run_id, .. } => run_id,
    };
    foreground_dispatch_outcome(db, &run_id, control)
}

/// Convert the durable lifecycle left by an adapter into the typed result the
/// cycle needs.  A marker being active is not sufficient by itself: a
/// completed Backfill reuse, for example, did not create a Run for this
/// dispatch and must remain an ordinary no-op completion.  Only the exact
/// Run that is still running is a foreground hold.
fn foreground_dispatch_outcome(
    db: &Database,
    run_id: &str,
    control: Option<&MaintenanceCycleControl<'_>>,
) -> anyhow::Result<MaintenanceDispatchOutcome> {
    if !foreground_system_work_barrier_requested() {
        // Controlled adapters already attach their Run before returning; avoid
        // a post-commit read that can lose the no-wait connection to foreground work.
        return Ok(MaintenanceDispatchOutcome::Completed);
    }
    if let Some(control) = control {
        if let Some(attach_run) = control.attach_run {
            let ownership = db.with_conn(|conn| {
                Ok(super::maintenance_lifecycle::try_load_running_maintenance_run_in_tx(
                    conn, run_id,
                )?
                .map(|handle| handle.core_ownership()))
            })?;
            if let Some(ownership) = ownership {
                attach_run(ownership)?;
            }
        }
    }
    let status = db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })?;
    Ok(if status.as_deref() == Some("running") {
        MaintenanceDispatchOutcome::ForegroundHeld
    } else {
        MaintenanceDispatchOutcome::Completed
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmarked_completed_dispatch_does_not_reacquire_busy_connection() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        let no_stop = || Ok(());
        let no_run = |_: &str| Ok(());
        let no_work = |_: &DesiredWork| Ok(());
        let unexpected_attach =
            |_: crate::workspace_lifecycle::RunOwnership| -> anyhow::Result<()> {
                panic!("unmarked completed dispatch must not attach a Run")
            };
        let control = MaintenanceCycleControl {
            should_stop: &no_stop,
            stop_signal: None,
            finalization_granted_signal: None,
            defer_preempted_run: &no_run,
            grant_finalize: &no_run,
            register_work: &no_work,
            work_started: &no_work,
            work_completed: &no_work,
            work_noop_completed: &no_work,
            work_deferred: &no_work,
            attach_run: Some(&unexpected_attach),
            reserve_run: None,
            mark_run_creation_started: None,
            mark_run_reuse_selection_unknown: None,
            mark_run_creation_outcome: None,
            reset_run_creation_tracking: None,
            mark_run_terminalized: None,
        };
        let _held = db.lock().expect("hold connection");
        let _no_wait = db.enter_maintenance_connection_no_wait();

        assert_eq!(
            foreground_dispatch_outcome(&db, "completed-run", Some(&control))
                .expect("unmarked completed dispatch needs no connection"),
            MaintenanceDispatchOutcome::Completed,
        );
    }

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
