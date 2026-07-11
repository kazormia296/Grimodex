#![cfg(not(feature = "licensing"))]

use grimodex_license::{
    activate_license, deactivate_license, get_license_state, revalidate_license,
    run_validate_cycle, LicenseRuntime, LicenseStateDto,
};

fn exact_disabled_dto() -> LicenseStateDto {
    LicenseStateDto {
        licensing_enabled: false,
        status: "disabled".to_string(),
        trial_days_remaining: None,
        grace_days_remaining: None,
        key_tail: None,
        activated_at: None,
        last_validated_at: None,
    }
}

#[tokio::test]
async fn disabled_build_has_exact_dto_never_touches_disk_and_rejects_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("nested/license.json");
    let runtime = LicenseRuntime::new(path.clone());

    assert_eq!(
        get_license_state(&runtime).expect("disabled get"),
        exact_disabled_dto()
    );
    assert!(!path.exists());
    assert!(activate_license(&runtime, "GRIM-KEY".to_string())
        .await
        .expect_err("activate disabled")
        .to_string()
        .contains("無効"));
    assert!(revalidate_license(&runtime)
        .await
        .expect_err("revalidate disabled")
        .to_string()
        .contains("無効"));
    assert!(deactivate_license(&runtime)
        .await
        .expect_err("deactivate disabled")
        .to_string()
        .contains("無効"));
    assert_eq!(run_validate_cycle(&runtime).await, None);
    assert!(!path.exists());
}
