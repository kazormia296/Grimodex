//! cargo test 用のリンクスタブ。
//!
//! `cargo test` のテストバイナリは Node ランタイム外でリンクされるため、
//! Node 本体が提供する `napi_*` シンボルが未定義になりリンクが失敗する
//! (cdylib 本体は未解決シンボルを許容し、Node ロード時に解決される)。
//! Rust 単体テストは ThreadsafeFunction の Registered 経路を通らない
//! (TSFn は Node 内でしか作れない) ので、リンクを満たすだけのスタブを差す。
//! 万一テストから呼ばれたら unreachable! で即座に顕在化する。
//!
//! Phase 3 で napi API の使用面が増えて undefined symbol が出たら、ここに
//! 同名スタブを追記する。

#![allow(clippy::missing_safety_doc)]

use std::ffi::c_void;

use napi::sys;

#[no_mangle]
unsafe extern "C" fn napi_call_threadsafe_function(
    _func: sys::napi_threadsafe_function,
    _data: *mut c_void,
    _is_blocking: sys::napi_threadsafe_function_call_mode,
) -> sys::napi_status {
    unreachable!("napi test stub: napi_call_threadsafe_function must not be called in cargo test")
}

#[no_mangle]
unsafe extern "C" fn napi_release_threadsafe_function(
    _func: sys::napi_threadsafe_function,
    _mode: sys::napi_threadsafe_function_release_mode,
) -> sys::napi_status {
    unreachable!(
        "napi test stub: napi_release_threadsafe_function must not be called in cargo test"
    )
}
