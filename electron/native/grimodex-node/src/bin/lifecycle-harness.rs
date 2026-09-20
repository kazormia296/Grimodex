//! Isolated Layer-A lifecycle model harness.
//!
//! This binary is opt-in (`--features test-lifecycle`) and is deliberately
//! separate from the N-API cdylib. It exercises the shared core's foreground
//! admission lane and the full-delivery -> ACK -> exact retry progress rule
//! without exposing a renderer or product capability in normal builds.

use anyhow::{ensure, Result};
use grimodex_db::{
    AdmissionRejection, DeliveryAdmissionOutcome, DeliverySequence, LiveBinding,
    PermitAdmission, WorkspaceLifecycleCore, DELIVERY_CAPACITY,
};

fn binding(instance: u64) -> LiveBinding {
    LiveBinding::new("/tmp/grimodex-lifecycle-harness", "harness", instance, 1)
}

fn main() -> Result<()> {
    let core = WorkspaceLifecycleCore::new();
    core.set_ready(binding(1))?;

    let mut foreground = match core.admit_foreground_permit()? {
        PermitAdmission::Admitted(permit) => permit,
        PermitAdmission::NotAdmitted { reason, .. } => {
            anyhow::bail!("foreground admission unexpectedly rejected: {reason:?}")
        }
    };
    foreground.start()?;
    ensure!(
        matches!(
            core.admit_maintenance_permit()?,
            PermitAdmission::NotAdmitted {
                reason: AdmissionRejection::ActiveOperation,
                ..
            }
        ),
        "maintenance must share the foreground execution lane"
    );
    foreground.mark_joined()?;
    foreground.release()?;

    for sequence in 1..=DELIVERY_CAPACITY as u64 {
        let sequence = DeliverySequence::new(sequence);
        ensure!(
            matches!(
                core.admit_delivery_at(sequence, format!("fingerprint-{sequence:?}"))?,
                DeliveryAdmissionOutcome::Accepted { .. }
            ),
            "delivery sequence {sequence:?} must be admitted"
        );
        core.mark_delivery_terminal(sequence)?;
    }
    let next = DeliverySequence::new(DELIVERY_CAPACITY as u64 + 1);
    ensure!(
        matches!(
            core.admit_delivery_at(next, "full-retry".to_owned())?,
            DeliveryAdmissionOutcome::Full { .. }
        ),
        "full delivery must reject without advancing the shared high-water mark"
    );
    core.ack_delivery(DeliverySequence::new(1))?;
    ensure!(
        matches!(
            core.admit_delivery_at(next, "full-retry".to_owned())?,
            DeliveryAdmissionOutcome::Accepted { .. }
        ),
        "the exact H+1 retry must proceed after ACK"
    );
    core.mark_delivery_terminal(next)?;
    core.ack_delivery(next)?;
    println!("lifecycle harness passed");
    Ok(())
}
