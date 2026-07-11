#![cfg(target_os = "linux")]

#[path = "support/linux_ime_server.rs"]
mod linux_ime_server;

use grimodex_db::ime_export::ImeConsumerPlatform;

const LINUX_CONSUMER_ID: &str = "fcitx5-grimodex";

#[test]
#[ignore = "requires GRIMODEX_LINUX_IME_SERVER pointing to fcitx5-grimodex-server"]
fn linux_server_process_registers_a_fresh_grimodex_consumer() -> anyhow::Result<()> {
    let status = linux_ime_server::spawn_and_wait_for_consumer(LINUX_CONSUMER_ID)?;

    assert!(
        status.effective_enabled,
        "auto mode must become effective while the Linux IME consumer is running"
    );
    let consumer = status
        .consumers
        .iter()
        .find(|consumer| consumer.consumer_id == LINUX_CONSUMER_ID)
        .expect("the running Linux IME server must register its canonical consumer ID");
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
