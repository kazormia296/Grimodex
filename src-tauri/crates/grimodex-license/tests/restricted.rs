//! D2a `license-control` while the profile is restricted (NIR-1 DA-1 ST2,
//! K3/2 L-1 / N-1): exact key grammar, fixed request fields, no proxy, no
//! redirect. The unrestricted client is covered by `polar.rs` and unchanged.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use grimodex_license::{
    restricted_client_for_tests, restricted_polar_activate_at, restricted_polar_deactivate_at,
    restricted_polar_validate_at, validate_restricted_license_key, PolarValidateOutcome,
    RESTRICTED_LICENSE_KEY_MAX_LEN,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const ORG: &str = "11111111-1111-4111-8111-111111111111";
const ACT: &str = "22222222-2222-4222-8222-222222222222";
const BENEFIT: &str = "ben-1";
const KEY: &str = "GRIMODEX-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3";

// -- key grammar --------------------------------------------------------------

#[test]
fn key_grammar_accepts_polar_shaped_keys() {
    for key in [
        KEY,
        "POLAR-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
        // Polar issues upper-case hex; lower-case hex is the same value.
        "polar-1c285b2c-8f78-4c6e-9b2d-5a1aa7e0d5e1",
        "A-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
        "GRIM_PRO-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
        "GRIM-PRO-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
        // 32 character prefix (the longest) -> the longest possible key.
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
    ] {
        validate_restricted_license_key(key).unwrap_or_else(|e| panic!("{key}: {e:#}"));
    }
    assert_eq!(RESTRICTED_LICENSE_KEY_MAX_LEN, 69);
    assert_eq!(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1".len(),
        RESTRICTED_LICENSE_KEY_MAX_LEN
    );
}

#[test]
fn key_grammar_rejects_everything_else() {
    let overlong_prefix = format!("{}-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1", "A".repeat(33));
    let overlong_tail = format!("{KEY}A");
    let free_form = "x".repeat(4096);
    let cases: Vec<(&str, &str)> = vec![
        ("empty", ""),
        ("whitespace only", "   "),
        ("old test shape", "GRIMO-TEST-KEY-1234"),
        ("uuid only", "1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1"),
        ("empty prefix", "-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1"),
        ("no separator", "GRIM1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1"),
        (
            "leading hyphen prefix",
            "-A-1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
        ),
        (
            "trailing hyphen prefix",
            "A--1C285B2C-8F78-4C6E-9B2D-5A1AA7E0D5E1",
        ),
        ("overlong prefix", overlong_prefix.as_str()),
        ("overlong tail", overlong_tail.as_str()),
        ("free-form payload", free_form.as_str()),
        (
            "leading space",
            " GRIMODEX-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3",
        ),
        (
            "trailing newline",
            "GRIMODEX-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3\n",
        ),
        (
            "trailing space",
            "GRIMODEX-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3 ",
        ),
        ("nul", "GRIMODEX-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3\u{0}3"),
        ("control", "GRIM\u{7}-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3"),
        (
            "tab in prefix",
            "GR\tM-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3",
        ),
        (
            "non-ascii prefix",
            "グリモ-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3",
        ),
        (
            "non-ascii hex",
            "GRIM-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E\u{e9}",
        ),
        ("non-hex uuid", "GRIM-8CA5F5G0-4C44-4E5B-B7C5-F8C3D3E3E3E3"),
        ("short group", "GRIM-8CA5F5B-4C44-4E5B-B7C5-F8C3D3E3E3E3"),
        ("long group", "GRIM-8CA5F5B00-4C44-4E5B-B7C5-F8C3D3E3E3E3"),
        ("moved hyphen", "GRIM-8CA5F5B0-4C444-E5B-B7C5-F8C3D3E3E3E3"),
        (
            "punctuation prefix",
            "GR.M-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3",
        ),
        ("url-ish prefix", "a/b-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3"),
        (
            "json-ish",
            "{\"key\":1}-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3",
        ),
    ];
    for (name, key) in cases {
        assert!(
            validate_restricted_license_key(key).is_err(),
            "{name} must be rejected: {key:?}"
        );
    }
}

#[tokio::test]
async fn malformed_key_sends_nothing() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let client = restricted_client_for_tests().expect("client");
    for key in [
        "",
        "GRIMO-TEST-KEY-1234",
        "x\nGRIM-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3",
    ] {
        let error = restricted_polar_activate_at(&client, &server.uri(), ORG, key)
            .await
            .expect_err("malformed key must be rejected");
        assert!(format!("{error:#}").contains("形式"), "{error:#}");
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}

/// Through the real entry point: with `licensing` a malformed key returns the
/// typed key error (not a connection error, so nothing was attempted); without
/// it the build-disabled error comes first.
#[tokio::test]
async fn restricted_entry_rejects_malformed_key_before_any_client() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = grimodex_license::LicenseRuntime::new(dir.path().join("license.json"));
    let error = grimodex_license::activate_license_restricted(&runtime, "bad key".to_string())
        .await
        .expect_err("rejected");
    let text = format!("{error:#}");
    if grimodex_license::LICENSING_ENABLED {
        assert!(text.contains("形式"), "{text}");
        assert!(!text.contains("接続できませんでした"), "{text}");
    } else {
        assert!(text.contains("ライセンス機構が無効"), "{text}");
    }
    assert!(!dir.path().join("license.json").exists());
}

// -- request shape ------------------------------------------------------------

#[tokio::test]
async fn request_bodies_carry_only_the_fixed_fields() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/customer-portal/license-keys/activate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "act-1",
            "license_key": { "id": "lk-1", "benefit_id": BENEFIT }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/customer-portal/license-keys/validate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "granted", "benefit_id": BENEFIT
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/customer-portal/license-keys/deactivate"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    let client = restricted_client_for_tests().expect("client");
    let activation = restricted_polar_activate_at(&client, &server.uri(), ORG, KEY)
        .await
        .expect("activate");
    assert_eq!(activation.activation_id, "act-1");
    let outcome = restricted_polar_validate_at(&client, &server.uri(), ORG, BENEFIT, KEY, ACT)
        .await
        .expect("validate");
    assert_eq!(
        outcome,
        PolarValidateOutcome::Valid {
            benefit_id: Some(BENEFIT.to_string())
        }
    );
    restricted_polar_deactivate_at(&client, &server.uri(), ORG, KEY, ACT)
        .await
        .expect("deactivate");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 3);
    let shapes: Vec<(String, Vec<String>)> = requests
        .iter()
        .map(|request| {
            let body: serde_json::Value = request.body_json().expect("json body");
            let mut keys: Vec<String> = body.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            (request.url.path().to_string(), keys)
        })
        .collect();
    assert_eq!(
        shapes,
        vec![
            (
                "/v1/customer-portal/license-keys/activate".to_string(),
                vec!["key".into(), "label".into(), "organization_id".into()]
            ),
            (
                "/v1/customer-portal/license-keys/validate".to_string(),
                vec![
                    "activation_id".into(),
                    "key".into(),
                    "organization_id".into()
                ]
            ),
            (
                "/v1/customer-portal/license-keys/deactivate".to_string(),
                vec![
                    "activation_id".into(),
                    "key".into(),
                    "organization_id".into()
                ]
            ),
        ]
    );
    let body: serde_json::Value = requests[0].body_json().unwrap();
    assert_eq!(body["key"], KEY);
    assert_eq!(body["organization_id"], ORG);
    assert_eq!(body["label"], grimodex_license::activation_label());
}

// -- redirect -----------------------------------------------------------------

#[tokio::test]
async fn redirects_are_typed_failures_and_never_followed() {
    let target = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&target)
        .await;
    let origin = MockServer::start().await;
    for status in [301u16, 302, 307, 308] {
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/activate"))
            .respond_with(
                ResponseTemplate::new(status)
                    .insert_header("Location", format!("{}/exfil", target.uri())),
            )
            .up_to_n_times(1)
            .mount(&origin)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/validate"))
            .respond_with(
                ResponseTemplate::new(status)
                    .insert_header("Location", format!("{}/exfil", target.uri())),
            )
            .up_to_n_times(1)
            .mount(&origin)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/deactivate"))
            .respond_with(
                ResponseTemplate::new(status)
                    .insert_header("Location", format!("{}/exfil", target.uri())),
            )
            .up_to_n_times(1)
            .mount(&origin)
            .await;
        let client = restricted_client_for_tests().expect("client");
        let activate = restricted_polar_activate_at(&client, &origin.uri(), ORG, KEY)
            .await
            .expect_err("redirect is a failure");
        assert!(format!("{activate:#}").contains(&format!("HTTP {status}")));
        let validate = restricted_polar_validate_at(&client, &origin.uri(), ORG, BENEFIT, KEY, ACT)
            .await
            .expect_err("redirect is a failure");
        assert!(format!("{validate:#}").contains(&format!("HTTP {status}")));
        let deactivate = restricted_polar_deactivate_at(&client, &origin.uri(), ORG, KEY, ACT)
            .await
            .expect_err("redirect is a failure");
        assert!(format!("{deactivate:#}").contains(&format!("HTTP {status}")));
    }
    assert!(target.received_requests().await.unwrap().is_empty());
}

/// Control for the test above: a client with the default redirect policy follows the same redirect, so
/// "target received 0" can only hold because of `Policy::none()`.
#[tokio::test]
async fn control_default_client_follows_the_redirect() {
    let target = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/exfil"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&target)
        .await;
    let origin = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/customer-portal/license-keys/validate"))
        .respond_with(
            ResponseTemplate::new(307).insert_header("Location", format!("{}/exfil", target.uri())),
        )
        .mount(&origin)
        .await;
    // `no_proxy` keeps this control off the env proxies the proxy test sets.
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("control client")
        .post(format!(
            "{}/v1/customer-portal/license-keys/validate",
            origin.uri()
        ))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("send");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(target.received_requests().await.unwrap().len(), 1);
}

// -- proxy --------------------------------------------------------------------

/// Counting listener that stands in for a proxy named by every proxy env var.
async fn proxy_stand_in() -> (String, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&accepted);
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            held.push(socket);
        }
    });
    (format!("http://{address}"), accepted)
}

/// The only test in this binary that touches the process environment, and no
/// other test here builds an env-reading client.
#[tokio::test]
async fn restricted_client_ignores_env_proxies_and_default_client_does_not() {
    let (proxy, accepted) = proxy_stand_in().await;
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::set_var(name, &proxy);
    }
    for name in ["NO_PROXY", "no_proxy"] {
        std::env::remove_var(name);
    }

    let origin = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/customer-portal/license-keys/validate"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"status": "granted", "benefit_id": BENEFIT})),
        )
        .mount(&origin)
        .await;

    // Control: a client that reads the environment is sent to the stand-in, so
    // this test can detect a proxy being used at all.
    let control = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .expect("control client");
    let _ = control
        .post(format!(
            "{}/v1/customer-portal/license-keys/validate",
            origin.uri()
        ))
        .send()
        .await;
    assert!(
        accepted.load(Ordering::SeqCst) >= 1,
        "control client must reach the stand-in proxy"
    );
    let before = accepted.load(Ordering::SeqCst);

    let client = restricted_client_for_tests().expect("client");
    let outcome = restricted_polar_validate_at(&client, &origin.uri(), ORG, BENEFIT, KEY, ACT)
        .await
        .expect("restricted validate reaches the origin directly");
    assert!(matches!(outcome, PolarValidateOutcome::Valid { .. }));
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        before,
        "restricted client must not connect to any env proxy"
    );
    assert_eq!(origin.received_requests().await.unwrap().len(), 1);
}

// -- static shape -------------------------------------------------------------

#[test]
fn restricted_client_builder_pins_no_proxy_no_redirect_and_https() {
    let source = include_str!("../src/lib.rs");
    let start = source
        .find("fn build_restricted_client(")
        .expect("restricted builder exists");
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").expect("builder ends")];
    assert!(body.contains(".no_proxy()"), "{body}");
    assert!(body.contains("redirect::Policy::none()"), "{body}");
    assert!(body.contains(".https_only(https_only)"), "{body}");

    // The production client is the https-only one and nothing else builds a
    // restricted client.
    assert_eq!(source.matches("build_restricted_client(true)").count(), 1);
    assert_eq!(source.matches("build_restricted_client(false)").count(), 1);

    // Fixed origin and the unrestricted client is untouched.
    assert!(source.contains("const POLAR_BASE_URL: &str = \"https://api.polar.sh\";"));
    let unrestricted = source
        .find("fn polar_http_client()")
        .expect("unrestricted client exists");
    let unrestricted = &source[unrestricted..];
    let unrestricted = &unrestricted[..unrestricted.find("\n}\n").unwrap()];
    assert!(!unrestricted.contains("no_proxy"));
    assert!(!unrestricted.contains("redirect"));
}
