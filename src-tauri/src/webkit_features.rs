//! WebKitGTK の機能フラグ (WebKitFeature, 2.42+) の有効化。
//!
//! WebKitGTK は <button> 等フォームコントロールの縦書き (writing-mode:
//! vertical-rl) を機能フラグ `VerticalFormControls`（status=stable だが
//! 2.52 時点でも既定 OFF）で拒否する。OFF のままだと縦書きエディタの Beat
//! 操作 UI が縦帯にならず、CSS 側は横書き島フォールバックに退避する
//! （index.css の `html[data-engine="webkitgtk"]:not([data-vfc="on"])` 島
//! ルール）。ここでフラグを立てられれば、フロントの probe
//! (src/lib/verticalFormControls.ts) が data-vfc="on" を立て、Chromium と
//! 同じ縦帯 chrome になる。
//!
//! webkit2gtk crate 2.0.x は feature API を未バインドのため、
//! libwebkit2gtk-4.1 が export するシンボルを dlsym(RTLD_DEFAULT) で解決して
//! 呼ぶ。シンボルが無い環境 (WebKitGTK < 2.42) では何もしない — 島 CSS
//! フォールバックが生きるだけで機能は壊れない。
//!
//! 重要（実測知見）: WebKitFeature はページ提供時のスナップショットで、
//! ロード後に有効化しても reload では反映されない。web process を
//! terminate してから reload するのが唯一確実な適用手順（起動直後の初期
//! ロードに対して行うためユーザー状態は失われない）。

use std::ffi::{c_char, c_int, c_void, CStr};

type GetAllFeaturesFn = unsafe extern "C" fn() -> *mut c_void;
type FeatureListGetLengthFn = unsafe extern "C" fn(*mut c_void) -> usize;
type FeatureListGetFn = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type FeatureGetIdentifierFn = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type SetFeatureEnabledFn = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int);
type FeatureListUnrefFn = unsafe extern "C" fn(*mut c_void);

/// dlsym で関数ポインタを解決する。`T` は `unsafe extern "C" fn` 型に限る。
///
/// # Safety
/// `name` のシンボルが実際に `T` のシグネチャを持つことは呼び出し側が保証する。
unsafe fn dlsym_fn<T: Copy>(name: &[u8]) -> Option<T> {
    debug_assert_eq!(
        std::mem::size_of::<T>(),
        std::mem::size_of::<*mut c_void>()
    );
    let cname = CStr::from_bytes_with_nul(name).ok()?;
    let sym = libc::dlsym(libc::RTLD_DEFAULT, cname.as_ptr());
    if sym.is_null() {
        None
    } else {
        Some(std::mem::transmute_copy::<*mut c_void, T>(&sym))
    }
}

/// `settings_ptr` (WebKitSettings*) に `VerticalFormControls` を立てる。
/// 立てられたら true。feature API が無い（WebKitGTK < 2.42）/ feature が
/// 見つからない場合は false。
fn enable_vertical_form_controls(settings_ptr: *mut c_void) -> bool {
    if settings_ptr.is_null() {
        return false;
    }
    unsafe {
        let Some(get_all) =
            dlsym_fn::<GetAllFeaturesFn>(b"webkit_settings_get_all_features\0")
        else {
            return false;
        };
        let (Some(list_len), Some(list_get), Some(feat_id), Some(set_enabled)) = (
            dlsym_fn::<FeatureListGetLengthFn>(b"webkit_feature_list_get_length\0"),
            dlsym_fn::<FeatureListGetFn>(b"webkit_feature_list_get\0"),
            dlsym_fn::<FeatureGetIdentifierFn>(b"webkit_feature_get_identifier\0"),
            dlsym_fn::<SetFeatureEnabledFn>(b"webkit_settings_set_feature_enabled\0"),
        ) else {
            return false;
        };
        let list = get_all();
        if list.is_null() {
            return false;
        }
        let mut enabled = false;
        let len = list_len(list);
        for i in 0..len {
            let feature = list_get(list, i);
            if feature.is_null() {
                continue;
            }
            let id = feat_id(feature);
            if id.is_null() {
                continue;
            }
            if CStr::from_ptr(id).to_bytes() == b"VerticalFormControls" {
                set_enabled(settings_ptr, feature, 1);
                enabled = true;
                break;
            }
        }
        if let Some(unref) = dlsym_fn::<FeatureListUnrefFn>(b"webkit_feature_list_unref\0") {
            unref(list);
        }
        enabled
    }
}

/// Tauri の with_webview から呼ぶエントリポイント。フラグを立てられた場合は
/// web process を再起動して反映する（上記の実測知見どおり reload 単独では
/// 反映されないため）。
///
/// `app_url` は再起動後にロードするアプリ URL（呼び出し側が
/// `window.url()` で取得して渡す）。setup の with_webview closure は初期
/// ナビゲーションのコミット前に走るため、terminate 後に `reload()` すると
/// 「現在の URI = about:blank」を再ロードして黒画面のまま止まる
/// （実機でクリーン起動 5/5 再現）。明示 `load_uri` で新しい web process
/// （フラグ適用済み）にアプリを載せ替える。
pub fn apply_vertical_form_controls(view: &webkit2gtk::WebView, app_url: Option<&str>) {
    use glib::translate::ToGlibPtr;
    use webkit2gtk::WebViewExt;

    let Some(settings) = view.settings() else {
        tracing::warn!(
            "webkitgtk: WebView settings unavailable; VerticalFormControls stays off"
        );
        return;
    };
    let settings_ptr: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
    if enable_vertical_form_controls(settings_ptr as *mut c_void) {
        tracing::info!(
            "webkitgtk: VerticalFormControls enabled; restarting web process to apply"
        );
        view.terminate_web_process();
        match app_url {
            Some(url) => view.load_uri(url),
            // URL が取れなかった場合の最終手段。初期ロード完了後なら reload で
            // 十分だが、起動直後は黒画面リスクがあるため基本 app_url を渡すこと。
            None => view.reload(),
        }
    } else {
        tracing::info!(
            "webkitgtk: VerticalFormControls feature unavailable (WebKitGTK < 2.42?); \
             vertical Beat chrome falls back to horizontal islands"
        );
    }
}
