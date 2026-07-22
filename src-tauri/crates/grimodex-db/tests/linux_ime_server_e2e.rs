#![cfg(target_os = "linux")]

#[path = "support/ime_consumer_process.rs"]
mod ime_consumer_process;

use grimodex_db::ime_export::ImeConsumerPlatform;

const LINUX_CONSUMER_ID: &str = "fcitx5-mozkey-ibg";
const LINUX_SERVER_ENV: &str = "GRIMODEX_LINUX_IME_SERVER";

#[test]
#[ignore = "requires GRIMODEX_LINUX_IME_SERVER pointing to the Mozkey IbG IME server"]
fn linux_server_process_registers_a_fresh_mozkey_ibg_consumer() -> anyhow::Result<()> {
    let status = ime_consumer_process::spawn_and_wait_for_consumer(
        LINUX_SERVER_ENV,
        "Mozkey IbG Linux IME server",
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
        .expect("the running Mozkey IbG server must register its canonical consumer ID");
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
