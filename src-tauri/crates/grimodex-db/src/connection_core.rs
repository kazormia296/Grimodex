//! 主接続とその取得規則の所有者（DR-DBC-6）。
//!
//! 接続・foreground の待ち・finalization の予約・健全性を 1 つの `Arc` にまとめる。背景の
//! checkpoint のスレッドは `Weak` で持ち、先払い（`background_checkpoint::prepay`）は
//! `Database` と同じ取得関数（`try_lock_conn_with_check` ほか。`lib.rs`）をそのまま使う。
//! 取得の規則（waiter・reservation・quarantine・maintenance の no-wait）を作り直さない。
//!
//! `Database` はこれを `Deref` で見せるので、`db.conn`・`db.lock_conn()` などの呼び出しは
//! 変わらない。型は `Deref::Target` として公開面に現れるので `pub`（この module は非公開で、
//! crate の外からは名前を指せない）。

use crate::narrative_maintenance_connection::ConnectionHealth;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

pub struct ConnectionCore {
    pub(crate) conn: Mutex<Connection>,
    /// Connections whose close returned the owned handle for an explicit
    /// retry. They never re-enter normal access; the owner keeps them here
    /// until a close succeeds and only then emits retirement proof.
    pub(crate) retired_connections: Mutex<Vec<Connection>>,
    pub(crate) foreground_connection_waiters: Arc<AtomicUsize>,
    pub(crate) maintenance_finalization_reserved: Arc<AtomicBool>,
    pub(crate) connection_health: ConnectionHealth,
}

impl ConnectionCore {
    pub(crate) fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
            retired_connections: Mutex::new(Vec::new()),
            foreground_connection_waiters: Arc::new(AtomicUsize::new(0)),
            maintenance_finalization_reserved: Arc::new(AtomicBool::new(false)),
            connection_health: ConnectionHealth::new(),
        }
    }
}
