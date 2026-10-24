//! DA-2 ST1: Native's side of the profile activation (K3/2 "activation の
//! trigger と開示" and "順序と起動時の gate"; DR-DA2-1 to DR-DA2-8 in
//! `docs/plans/nir1-lane-decisions/da2-decisions.md`).
//!
//! Main runs the activation; Native owns the parts that need its authority:
//!
//! 1. `preview`: behind the closed-by-default pre-publication gate
//!    (`PrePublicationEntry::ProfileActivation`), Native builds the dialog
//!    text from its own constants and binds the grant to the profile ID, the
//!    caller epoch, the disclosure version and the digest of that text.
//! 2. `issue`: Main passes the digest of the strings it actually showed; a
//!    difference revokes the grant (P2-3).
//! 3. `consume` (stage 1, synchronous): the grant becomes the activation's
//!    reservation. Nothing is closed by a refusal.
//! 4. `commit` (stages 4 and 5): the durable restriction, then the bounded
//!    stop barrier. Only a successful commit ends the reservation.
//!
//! No response carries an id other than the previewId and the grantId that
//! Main passes back, nor a digest, an epoch or the profile ID. Refusals are
//! closed codes: `PROFILE_ACTIVATION_REFUSED:<code>`, `MAIN_GRANT_*` and
//! `PROFILE_EGRESS_UNAVAILABLE:<code>`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use grimodex_core::canonical_json_digest;
use grimodex_db::workspace_lifecycle::LifecycleState;
use grimodex_db::AppError;
use napi::{Error, Result};
use serde::Serialize;
use serde_json::json;

use crate::main_grant::{
    profile_activation_grant_digest, GrantPayload, GrantRefusal, MainGrantKind,
    PrePublicationEntry, PreviewInit, ProfileActivationGrantPayload,
};
use crate::profile_egress::ProfileEgressUnavailable;
use crate::state::AppState;

/// The version of the disclosure below (K3/2 "開示に必ず含めるもの" 8). The
/// text is a **draft**: Session C-1 approves it, and any change to the text
/// raises this version (DR-DA2-1, D-16).
pub(crate) const PROFILE_ACTIVATION_DISCLOSURE_VERSION: u32 = 1;

/// The disclosure is a draft until Session C-1. A test ties this mark to the
/// version and to the gate being closed by default.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const PROFILE_ACTIVATION_DISCLOSURE_IS_DRAFT: bool = true;

/// The bound of stage 5 and of the startup stop barrier (K3/2 "待ちの上限":
/// 30 s or less, fail closed; DR-DA2-5). ST5 measures it and may shorten it;
/// a longer value needs a new confirmation.
pub(crate) const PROFILE_EGRESS_STOP_BARRIER_BOUND_MS: u64 = 30_000;

pub(crate) const fn stop_barrier_bound() -> Duration {
    Duration::from_millis(PROFILE_EGRESS_STOP_BARRIER_BOUND_MS)
}

/// Domain of the dialog-text digest. Main computes the same digest over the
/// strings it passes to `dialog.showMessageBox` (DR-DA2-3).
pub(crate) const DISPLAY_DIGEST_DOMAIN: &str = "grimodex/main-grant/v1/profile-activation/display";

// ─────────────────── the disclosure (draft, Session C-1) ───────────────────

const TITLE: &str = "外部の AI を使わない設定を有効にしますか";

const MESSAGE: &str = "有効にすると、この設定（profile）では外部の AI への送信と既存の AI の機能が閉じます。アプリの操作では解除できません。";

const DETAIL: &str = "\
1. 対象: この設定（profile）のすべての workspace、作品、会話、窓に及び、再起動の後も続きます。別の端末や別の profile、設定を初期化したアプリで同じ workspace を開いた場合は制限されません。
2. 一方向: アプリの操作では解除できません。設定のフォルダにある状態ファイルを消すと、次の起動で制限が外れ、制限の間に作られた会話などのデータも外部の AI の経路から読める状態に戻ります。外部の AI を使い続けたい場合は有効にしないでください。
3. 閉じるもの: 外部の AI への送信と既存の AI の全経路（provider、ローカルの Ollama、inline、CLI、Codex App Server を含む）、実行中の AI の処理（取り消します）、AI の補助機能の開始（タイトル、要約、校閲、Agent、伏線の提案など）、接続試験、外部 URL を開く操作、Vivliostyle（組版、プレビュー、CLI の検出。書出しの Vivliostyle の tab を開いても、CLI を探して起動しません）、MCP の連携、行を挿入する chat の書込み（新しい会話の作成、場面の会話の外での入力の保存、chat を含む import の会話の部分の取込み）と、restricted で使えない既存の機能。入力は既存の場面の会話でだけ保存され、ほかの会話ではメッセージの編集して再送も閉じます。会話のない場面では Codex の文脈 pin もできません。import は会話の部分を取り込まず、そのことを示して残りを取り込みます。
4. 続くもの: 原稿の編集と保存、restricted でも使えるように移した既存の操作（M と T に分類した操作）、Related Scenes、A2 review、Scope の宣言、外へ出ない自分のデータの閲覧（読取専用。過去の会話、伏線・プロット・lint・用語辞書・ゴミ箱の一覧、版の過去の本文、snapshot の復元の文脈、全文検索と意味検索、Codex のハイライト、執筆統計とタイムラプス、AI audit の閲覧と検証と export、post-effect の注記、抽出の review の表示と再開、agent の提案の再表示、生成の出所の表示）、会話の整理（メッセージと会話の削除、会話の改名、履歴の全消去、Codex と snippet への抽出、本文への挿入、既存の会話への Codex の文脈 pin）。生成の途中で終わらなかった attempt が残った会話や project では、次の Open か Restore、または再起動まで、削除と履歴の全消去が拒否されることがあります。既存の場面の会話への入力は保存されます（AI の応答はありません）。メッセージの編集して再送は場面の会話でだけ使え、編集したメッセージとその後の応答を消し、再送は入力の保存だけになります。Graph は公開の後に、local 生成はその公開（PUB-L）の後に使えます。それまでは AI の応答を得る手段がありません。
5. 続く通信: license の確認（proxy を使わずに直接つなぎます。proxy が必須の環境では確認できず、license の期限の規則で編集が制限されることがあります）、更新の確認と download と適用（適用は、取得した更新の installer を起動します）、意味モデルの download（model がなければ project を開くと自動で始まります）、IME 辞書（Mozkey）の installer の download と起動（固定の GitHub の配信元から取得し、同じ release の checksum と照合した installer を、OS の既定の処理で開きます）、アプリ内部の待受け（127.0.0.1）への接続（データを運びません）。Chromium の spellchecker は辞書の取得を試みますが、取得できません。どれも原稿や会話を送りませんが、接続元の IP は相手に届きます。installer の起動は、アプリの画面が利用者の操作なしに始めることもできます（起動の時期だけを選べ、起動するものは選べません）。
6. データ: 有効にしても何も消えません。閉じた機能のデータも保存されたまま残り、読取専用の閲覧で見られます。会話は restricted の間も自分で消せます（4 の attempt が残る間を除く）。ただし、保存のときにタイムラプスの記録に写された本文（タイムラプスの記録が有効な project で写されます）は、会話やメッセージを消しても消えず、タイムラプスの再生（設定の履歴の消去で再生から隠すまで）と、アプリの画面のコードから読めます。この写しは設定の履歴の消去でも消えません（履歴の消去も記録そのものは残します）。project ごと削除したときは、記録も project とともに消えます。restricted にする前から同じです。
7. 残余: restricted でも、アプリの画面のコードは閲覧できる自分のデータを読めます。画面が乗っ取られたときに外へ出せる可能性が残る経路は次のとおりです。(a) 画面から外へ直接送る経路（WebRTC と名前解決を含む）は、確かめたうえで閉じています。(b) 外部 folder の mount: 利用者の操作なしに任意の folder を登録でき、その下の既存の .md を読み、全置換できます。全置換できる .md には、AI の agent など別のプログラムが起動時に指示として読むもの（CLAUDE.md、AGENTS.md など）が含まれ、そのプログラムを次に起動したときに、原稿や会話を外へ送ったり制限の状態を解いたりしえます。workspace の open も同じで、任意の folder に workspace を作って切り替え、閲覧できるデータを書き写せます。同期 software の対象の folder なら、同期が外へ送ります。(c) clipboard への書込みと通知: OS や連携 software が別の端末へ送りえます。(d) local 生成の公開（PUB-L）の後の local 送信: AI の設定は画面も書き換えられるので、接続先が未設定でも、この端末で待ち受ける任意のプログラム（受け取ったものを別の host へ中継するものを含む）へ、閲覧できる自分のデータを含む要求を送れます。(e) IME 連携: 有効なら、project の題名、ジャンル、あらすじと、Codex の名前と読みを IME が読む file に書きます。(a)〜(c) と (e) は restricted にする前から同じ能力で、(b) の .md への限定だけが restricted で加わります。(d) は local 生成の公開が加える能力です。窓の題名は restricted の間は固定します。
8. 開示の版: 1";

const CHECKBOX_LABEL: &str = "アプリの操作では解除できないことを理解しました";
const CANCEL_LABEL: &str = "取消";
const APPROVE_LABEL: &str = "有効にする";

/// The dialog Main shows, word for word (K3/2 "Main の確認" 3 and 4). The
/// default and the cancel button are both index 0 (取消); approval needs the
/// approve button **and** the checked box.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileActivationDisplay {
    pub(crate) title: &'static str,
    pub(crate) message: &'static str,
    pub(crate) detail: &'static str,
    pub(crate) checkbox_label: &'static str,
    pub(crate) buttons: [&'static str; 2],
    pub(crate) default_id: u32,
    pub(crate) cancel_id: u32,
}

pub(crate) const fn display() -> ProfileActivationDisplay {
    ProfileActivationDisplay {
        title: TITLE,
        message: MESSAGE,
        detail: DETAIL,
        checkbox_label: CHECKBOX_LABEL,
        buttons: [CANCEL_LABEL, APPROVE_LABEL],
        default_id: 0,
        cancel_id: 0,
    }
}

/// `"sha256:" + hex(SHA-256(canonical JSON))` of
/// `{ domain, disclosureVersion, display }` (keys in UTF-16 order, as
/// `canonicalJson` in `electron/main/mainGrant.ts` orders them).
pub(crate) fn display_digest(display: &ProfileActivationDisplay) -> anyhow::Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": DISPLAY_DIGEST_DOMAIN,
        "disclosureVersion": PROFILE_ACTIVATION_DISCLOSURE_VERSION,
        "display": serde_json::to_value(display)?,
    }))?)
}

// ───────────────────────────── refusals ─────────────────────────────

/// The refusals of this entry that are not the slot's (`MAIN_GRANT_*`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActivationRefusal {
    /// The pre-publication gate is closed (Main answers `not-activated`).
    GateClosed,
    AlreadyRestricted,
    /// Native's profile gate is unavailable in this process.
    Unavailable,
    /// The workspace lifecycle is in a transition, recovery, closed, or the
    /// app is shutting down (D-3).
    LifecycleBusy,
    /// The digest Main passed is not the digest of Native's dialog text.
    DisplayMismatch,
}

impl ActivationRefusal {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::GateClosed => "PROFILE_ACTIVATION_REFUSED:gate-closed",
            Self::AlreadyRestricted => "PROFILE_ACTIVATION_REFUSED:already-restricted",
            Self::Unavailable => "PROFILE_ACTIVATION_REFUSED:unavailable",
            Self::LifecycleBusy => "PROFILE_ACTIVATION_REFUSED:lifecycle-busy",
            Self::DisplayMismatch => "PROFILE_ACTIVATION_REFUSED:display-mismatch",
        }
    }
}

fn refuse<T>(refusal: ActivationRefusal) -> std::result::Result<T, AppError> {
    Err(AppError::Anyhow(anyhow!(refusal.code())))
}

fn grant_error<T>(refusal: GrantRefusal) -> std::result::Result<T, AppError> {
    Err(AppError::Anyhow(refusal.into_error()))
}

fn require_gate(state: &AppState) -> std::result::Result<(), AppError> {
    if state
        .main_grant
        .gate
        .is_open(PrePublicationEntry::ProfileActivation)
    {
        Ok(())
    } else {
        refuse(ActivationRefusal::GateClosed)
    }
}

/// D-3: the preview does not need a Ready workspace (no workspace is fine),
/// but a transition, a recovery, a closed Core or a shutdown refuses it.
fn previewable_lifecycle_revision(state: &AppState) -> std::result::Result<u64, AppError> {
    if state.workspace_lifecycle.shutdown_requested()? {
        return refuse(ActivationRefusal::LifecycleBusy);
    }
    let snapshot = state.workspace_lifecycle.lifecycle_snapshot()?;
    match snapshot.state {
        LifecycleState::NoWorkspace | LifecycleState::Ready(_) => Ok(snapshot.revision),
        _ => refuse(ActivationRefusal::LifecycleBusy),
    }
}

/// The binding of a grant made now: the profile must be unrestricted and
/// available.
fn current_binding(
    state: &AppState,
) -> std::result::Result<ProfileActivationGrantPayload, AppError> {
    let status = state.profile_egress.status();
    if status.unavailable_reason.is_some() {
        return refuse(ActivationRefusal::Unavailable);
    }
    if status.restricted {
        return refuse(ActivationRefusal::AlreadyRestricted);
    }
    Ok(ProfileActivationGrantPayload {
        profile_id: status.profile_id,
        caller_epoch: status.caller_epoch,
        disclosure_version: PROFILE_ACTIVATION_DISCLOSURE_VERSION,
        disclosure_digest: display_digest(&display()).map_err(AppError::Anyhow)?,
    })
}

// ───────────────────────────── the entries ─────────────────────────────

/// Main's preview. The gate is the first check: a closed gate refuses before
/// the slot, the profile or the lifecycle is read. Returns
/// `{ previewId, display, disclosureVersion, expiresInMs }`; Main digests the
/// version and the strings it shows with [`display_digest`]'s rule.
pub(crate) fn preview(
    state: &Arc<AppState>,
    sender_id: u32,
    window_id: u32,
) -> std::result::Result<String, AppError> {
    require_gate(state)?;
    let registry = &state.main_grant.registry;
    registry.ensure_can_preview().or_else(grant_error)?;
    let epoch = registry.edge_epoch();
    let binding = current_binding(state)?;
    let revision = previewable_lifecycle_revision(state)?;
    let digest = profile_activation_grant_digest(&binding, revision, sender_id, window_id)
        .map_err(AppError::Anyhow)?;
    let handle = registry
        .insert_preview(
            PreviewInit {
                kind: MainGrantKind::ProfileActivation,
                sender_id,
                window_id,
                digest,
                lifecycle_revision: revision,
                payload: GrantPayload::ProfileActivation(binding),
            },
            epoch,
        )
        .or_else(grant_error)?;
    Ok(json!({
        "previewId": handle.preview_id,
        "display": display(),
        "disclosureVersion": PROFILE_ACTIVATION_DISCLOSURE_VERSION,
        "expiresInMs": handle.expires_in_ms,
    })
    .to_string())
}

/// Turns an approved preview into a grant. `shown_display_digest` is the
/// digest of the strings Main showed; Native compares it with the digest of
/// its own text bound at the preview, and any difference, a change of the
/// profile, the lifecycle or the gate revokes the grant.
pub(crate) fn issue(
    state: &Arc<AppState>,
    preview_id: &str,
    sender_id: u32,
    window_id: u32,
    shown_display_digest: &str,
) -> std::result::Result<String, AppError> {
    let registry = &state.main_grant.registry;
    let ticket = registry
        .begin_issue(preview_id, sender_id, window_id)
        .or_else(grant_error)?;
    let check = || -> std::result::Result<String, AppError> {
        let GrantPayload::ProfileActivation(bound) = &ticket.payload else {
            return grant_error(GrantRefusal::WrongKind);
        };
        require_gate(state)?;
        let current = current_binding(state)?;
        let revision = previewable_lifecycle_revision(state)?;
        if revision != ticket.lifecycle_revision || &current != bound {
            return grant_error(GrantRefusal::StateChanged);
        }
        if shown_display_digest != bound.disclosure_digest {
            return refuse(ActivationRefusal::DisplayMismatch);
        }
        profile_activation_grant_digest(bound, revision, ticket.sender_id, ticket.window_id)
            .map_err(AppError::Anyhow)
    };
    let digest = match check() {
        Ok(digest) => digest,
        Err(error) => {
            registry.revoke(preview_id);
            return Err(error);
        }
    };
    let grant_id = registry
        .finish_issue(preview_id, &digest)
        .or_else(grant_error)?;
    Ok(json!({ "grantId": grant_id }).to_string())
}

/// Stage 1 (synchronous, P3-1): consumes the grant into the reservation. The
/// binding is compared with the profile as it is now; any difference closes
/// nothing (the profile and the state file are unchanged).
pub(crate) fn consume(
    state: &Arc<AppState>,
    grant_id: &str,
    sender_id: u32,
    window_id: u32,
) -> std::result::Result<(), AppError> {
    let revision = state.workspace_lifecycle.lifecycle_snapshot()?.revision;
    let status = state.profile_egress.status();
    let current_digest = display_digest(&display()).map_err(AppError::Anyhow)?;
    state
        .main_grant
        .registry
        .consume_profile_activation(grant_id, sender_id, window_id, revision, |bound| {
            status.unavailable_reason.is_none()
                && !status.restricted
                && bound.profile_id == status.profile_id
                && bound.caller_epoch == status.caller_epoch
                && bound.disclosure_version == PROFILE_ACTIVATION_DISCLOSURE_VERSION
                && bound.disclosure_digest == current_digest
        })
        .or_else(grant_error)?;
    state.profile_egress.mark_activation_reserved();
    Ok(())
}

/// Stages 4 and 5. The reservation's token is taken once; stage 4 re-checks
/// the binding under the profile mutex and persists the restriction; stage 5
/// runs the stop barrier within its bound. Only success ends the reservation.
/// A stage 4 failure still asks every in-flight AI work to stop (F2).
pub(crate) async fn commit(state: &Arc<AppState>) -> Result<String> {
    commit_bounded(state, stop_barrier_bound()).await
}

pub(crate) async fn commit_bounded(state: &Arc<AppState>, bound: Duration) -> Result<String> {
    let consumed = state
        .main_grant
        .registry
        .take_reservation()
        .map_err(|refusal| Error::from_reason(refusal.code()))?;
    if let Err(error) = state
        .profile_egress
        .activate_first_restricted_publication(&consumed, false)
    {
        tracing::warn!("profile activation stage 4 failed: {error:#}");
        // Stage 2 already stopped new work, but what was accepted before it
        // is still running. Ask every kind of it to stop, without waiting,
        // confirming or clearing anything (DA-2 ST1 review F2, DR-DA2-20).
        crate::request_profile_egress_stop(state);
        return Err(crate::profile_egress_unavailable_error(
            state,
            ProfileEgressUnavailable::ActivationFailed,
        ));
    }
    let status = crate::settle_profile_egress_bounded(state, bound).await?;
    state.main_grant.registry.finish_reservation();
    Ok(status)
}

#[cfg(test)]
#[path = "profile_activation_tests.rs"]
mod tests;
