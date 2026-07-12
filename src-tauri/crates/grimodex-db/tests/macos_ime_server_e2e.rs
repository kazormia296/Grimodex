#![cfg(target_os = "macos")]

#[path = "support/ime_consumer_process.rs"]
mod ime_consumer_process;

use grimodex_db::ime_export::ImeConsumerPlatform;

const MACOS_CONSUMER_ID: &str = "azookey-grimodex";
const MACOS_SERVER_ENV: &str = "GRIMODEX_MACOS_IME_SERVER";

#[test]
#[ignore = "requires GRIMODEX_MACOS_IME_SERVER pointing to the real ConverterServer"]
fn macos_server_process_registers_a_fresh_grimodex_consumer() -> anyhow::Result<()> {
    let status = ime_consumer_process::spawn_and_wait_for_consumer(
        MACOS_SERVER_ENV,
        "Grimodex macOS ConverterServer",
        MACOS_CONSUMER_ID,
    )?;

    assert!(
        status.effective_enabled,
        "auto mode must become effective while the macOS IME consumer is running"
    );
    let consumer = status
        .consumers
        .iter()
        .find(|consumer| consumer.consumer_id == MACOS_CONSUMER_ID)
        .expect("the running macOS ConverterServer must register its canonical consumer ID");
    assert!(matches!(
        consumer.platform,
        Some(ImeConsumerPlatform::Macos)
    ));
    assert!(consumer.capabilities.profile);
    assert!(consumer.capabilities.dynamic_dictionary);
    assert!(consumer.capabilities.zenzai_v3_conditions);
    assert!(consumer.capabilities.application_scoping);

    Ok(())
}
