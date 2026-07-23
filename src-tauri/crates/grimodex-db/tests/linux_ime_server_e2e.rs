#![cfg(target_os = "linux")]

#[path = "support/ime_consumer_process.rs"]
mod ime_consumer_process;

use grimodex_db::ime_export::ImeConsumerPlatform;

const LINUX_CONSUMER_ID: &str = "fcitx5-mozkey-ibg";
const LINUX_LAUNCHER_ENV: &str = "GRIMODEX_LINUX_MOZKEY_LAUNCHER";

#[test]
#[ignore = "requires GRIMODEX_LINUX_MOZKEY_LAUNCHER pointing to launch_fcitx5_mozkey_e2e"]
fn linux_fcitx5_launcher_registers_a_fresh_mozkey_ibg_consumer() -> anyhow::Result<()> {
    let status = ime_consumer_process::spawn_and_wait_for_consumer(
        LINUX_LAUNCHER_ENV,
        "Mozkey IbG Fcitx5 launcher",
        LINUX_CONSUMER_ID,
    )?;

    assert!(
        status.effective_enabled,
        "auto mode must become effective while the Linux IME consumer is running"
    );
    let consumer = status
        .consumers
        .iter()
        .find(|consumer| consumer.consumer_id == LINUX_CONSUMER_ID)
        .expect("the running Mozkey IbG Fcitx5 addon must register its canonical consumer ID");
    assert!(matches!(
        consumer.platform,
        Some(ImeConsumerPlatform::Linux)
    ));
    assert!(consumer.capabilities.profile);
    assert!(consumer.capabilities.dynamic_dictionary);
    assert!(consumer.capabilities.zenzai_v3_conditions);
    assert!(consumer.capabilities.application_scoping);

    Ok(())
}
