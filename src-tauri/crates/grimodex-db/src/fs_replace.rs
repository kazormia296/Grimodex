//! Windows で既存ファイルを置き換える rename / ReplaceFileW の再試行。
//!
//! Windows では置き換え先（あるいは直前に書いた置き換え元）を別のプロセス
//! （ユーザーのエディタ、ウイルス対策、同期クライアント等）が一時的に開いていると、
//! 上書き rename が `PermissionDenied`（ERROR_ACCESS_DENIED = 5）や
//! ERROR_SHARING_VIOLATION（32）で失敗する。この状態は通常すぐ解消するため、
//! Windows かつこれらのエラーのときだけ短く待って再試行する。
//!
//! 方針（Electron main の `renameWithRetry` と同じ）:
//! - 待機は 10 ms から倍々で 100 ms 頭打ち、累積待機の上限は 2 秒
//! - 対象外のエラー、および Windows 以外では再試行せず即失敗する
//! - 上限を超えたら最後のエラーを返す
//!
//! 対象外: ディレクトリの rename、置き換え先が存在しない rename、
//! SQLite の DB 本体の差し替え（復元・マイグレーション。呼び出し側が
//! 排他とロールバックで制御しており、開いているハンドルは待っても解消しない）。

use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

const INITIAL_DELAY: Duration = Duration::from_millis(10);
const MAX_DELAY: Duration = Duration::from_millis(100);
const MAX_TOTAL_WAIT: Duration = Duration::from_secs(2);

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;

/// 再試行対象の一時的な競合エラーか（EPERM／EACCES／EBUSY 相当）。
pub fn is_transient_replace_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(
            error.raw_os_error(),
            Some(ERROR_ACCESS_DENIED) | Some(ERROR_SHARING_VIOLATION)
        )
}

/// 判定と待機を注入できる再試行本体（テスト用に公開）。
pub fn retry_with<F, S>(mut operation: F, windows: bool, mut sleep: S) -> io::Result<()>
where
    F: FnMut() -> io::Result<()>,
    S: FnMut(Duration),
{
    let mut delay = INITIAL_DELAY;
    let mut waited = Duration::ZERO;
    loop {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !windows || !is_transient_replace_error(&error) || waited >= MAX_TOTAL_WAIT {
                    return Err(error);
                }
                let step = delay.min(MAX_TOTAL_WAIT - waited);
                sleep(step);
                waited += step;
                delay = (delay * 2).min(MAX_DELAY);
            }
        }
    }
}

/// 既存ファイルの置き換え操作（rename や ReplaceFileW）を Windows でのみ再試行する。
pub fn retry_replace<F>(operation: F) -> io::Result<()>
where
    F: FnMut() -> io::Result<()>,
{
    retry_with(operation, cfg!(windows), thread::sleep)
}

/// `std::fs::rename` を `retry_replace` で包む。
pub fn rename_replace_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    retry_replace(|| std::fs::rename(from, to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn denied() -> io::Error {
        io::Error::from(io::ErrorKind::PermissionDenied)
    }

    #[test]
    fn succeeds_after_transient_failures_with_backoff() {
        let calls = Cell::new(0);
        let sleeps = RefCell::new(Vec::new());
        let result = retry_with(
            || {
                calls.set(calls.get() + 1);
                if calls.get() <= 3 {
                    Err(denied())
                } else {
                    Ok(())
                }
            },
            true,
            |d| sleeps.borrow_mut().push(d.as_millis()),
        );
        assert!(result.is_ok());
        assert_eq!(calls.get(), 4);
        assert_eq!(*sleeps.borrow(), vec![10, 20, 40]);
    }

    #[test]
    fn raw_sharing_violation_is_retried() {
        let calls = Cell::new(0);
        let result = retry_with(
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Err(io::Error::from_raw_os_error(32))
                } else {
                    Ok(())
                }
            },
            true,
            |_| {},
        );
        assert!(result.is_ok());
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn gives_up_at_cap_and_returns_last_error() {
        let calls = Cell::new(0u32);
        let total = Cell::new(Duration::ZERO);
        let result = retry_with(
            || {
                calls.set(calls.get() + 1);
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("attempt {}", calls.get()),
                ))
            },
            true,
            |d| total.set(total.get() + d),
        );
        let error = result.expect_err("must fail at the cap");
        assert_eq!(total.get(), MAX_TOTAL_WAIT);
        assert_eq!(error.to_string(), format!("attempt {}", calls.get()));
        assert!(calls.get() > 2);
    }

    #[test]
    fn non_transient_error_fails_immediately() {
        let calls = Cell::new(0);
        let slept = Cell::new(false);
        let result = retry_with(
            || {
                calls.set(calls.get() + 1);
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            true,
            |_| slept.set(true),
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(calls.get(), 1);
        assert!(!slept.get());
    }

    #[test]
    fn non_windows_fails_immediately_even_for_permission_denied() {
        let calls = Cell::new(0);
        let slept = Cell::new(false);
        let result = retry_with(
            || {
                calls.set(calls.get() + 1);
                Err(denied())
            },
            false,
            |_| slept.set(true),
        );
        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
        assert!(!slept.get());
    }

    #[test]
    fn rename_replaces_existing_file() {
        let dir =
            std::env::temp_dir().join(format!("grimodex-fs-replace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("a.tmp");
        let to = dir.join("a.json");
        std::fs::write(&to, b"old").unwrap();
        std::fs::write(&from, b"new").unwrap();
        rename_replace_with_retry(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
