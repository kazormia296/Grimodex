//! Diagnostic-only upper bound on simultaneous disposable file lengths.
//!
//! initial DB/sidecars + Linux wchar + every SQLite positive file/SHM growth
//! bounds the high-water even when a file is unlinked between observations.
//! wchar covers ordinary writes and copy_file_range (Rust file copies); the
//! VFS term also covers sparse writes/truncation and mmap-backed WAL indices.
//! Normal SQLite writes are deliberately counted twice. This is a logical
//! file-size bound, not physical filesystem metadata/preallocation accounting.

use anyhow::{Context, Result};
use rusqlite::ffi;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::{c_char, c_int, c_void};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};

#[derive(Default)]
struct Counter {
    growth: AtomicU64,
    shm_growth: AtomicU64,
    opens: AtomicU64,
    closes: AtomicU64,
    failed: AtomicBool,
}

struct FileMeter {
    original: usize,
    _methods: Box<ffi::sqlite3_io_methods>,
    size: u64,
    shm_size: u64,
    counter: Arc<Counter>,
}

static FILES: Mutex<BTreeMap<usize, FileMeter>> = Mutex::new(BTreeMap::new());
static PARENT_VFS: OnceLock<usize> = OnceLock::new();
static REGISTERED: OnceLock<c_int> = OnceLock::new();
thread_local! {
    static ACTIVE: RefCell<Option<Arc<Counter>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityDiskMeasurement {
    pub logical_high_water_upper_bound_bytes: u64,
    pub initial_bytes: u64,
    pub successful_write_bytes: u64,
    pub sqlite_file_growth_bytes: u64,
    pub sqlite_shm_growth_bytes: u64,
    pub opened_files: u64,
    pub closed_files: u64,
    pub method: &'static str,
    pub coverage: &'static str,
    pub uncertainty: &'static str,
}

pub(super) struct DiskMeasurement {
    counter: Arc<Counter>,
    initial_bytes: u64,
    initial_wchar: Option<u64>,
}

fn wchar() -> Option<u64> {
    std::fs::read_to_string("/proc/self/io")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("wchar:")?.trim().parse().ok())
}

impl DiskMeasurement {
    pub(super) fn start(database: &Path) -> Result<Self> {
        anyhow::ensure!(
            ACTIVE.with(|active| active.borrow().is_none()),
            "nested disk measurement"
        );
        let status = *REGISTERED.get_or_init(|| unsafe {
            // SAFETY: SQLite VFS registration is serialized by OnceLock. The
            // cloned default and its name live for the process lifetime. Only
            // xOpen changes; all platform methods retain their own pAppData.
            let parent = ffi::sqlite3_vfs_find(std::ptr::null());
            if parent.is_null() {
                return ffi::SQLITE_CANTOPEN;
            }
            let _ = PARENT_VFS.set(parent as usize);
            let mut vfs = Box::new(std::ptr::read(parent));
            vfs.zName = c"grimodex-capacity-disk".as_ptr();
            vfs.pNext = std::ptr::null_mut();
            vfs.xOpen = Some(open);
            ffi::sqlite3_vfs_register(Box::into_raw(vfs), 1)
        });
        anyhow::ensure!(
            status == ffi::SQLITE_OK,
            "capacity VFS registration failed: {status}"
        );
        let mut initial_bytes = 0u64;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut name = database.as_os_str().to_owned();
            name.push(suffix);
            match std::fs::metadata(name) {
                Ok(metadata) => {
                    initial_bytes = initial_bytes
                        .checked_add(metadata.len())
                        .context("initial disk bytes overflow")?
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() => {}
                Err(error) => return Err(error.into()),
            }
        }
        let counter = Arc::new(Counter::default());
        ACTIVE.with(|active| *active.borrow_mut() = Some(Arc::clone(&counter)));
        Ok(Self {
            counter,
            initial_bytes,
            initial_wchar: wchar(),
        })
    }

    pub(super) fn finish(&self) -> Option<CapacityDiskMeasurement> {
        let counter = &self.counter;
        let opened_files = counter.opens.load(Ordering::Relaxed);
        let closed_files = counter.closes.load(Ordering::Relaxed);
        if counter.failed.load(Ordering::Relaxed)
            || opened_files == 0
            || opened_files != closed_files
        {
            return None;
        }
        let successful_write_bytes = wchar()?.checked_sub(self.initial_wchar?)?;
        let sqlite_file_growth_bytes = counter.growth.load(Ordering::Relaxed);
        let sqlite_shm_growth_bytes = counter.shm_growth.load(Ordering::Relaxed);
        let logical_high_water_upper_bound_bytes = self
            .initial_bytes
            .checked_add(successful_write_bytes)?
            .checked_add(sqlite_file_growth_bytes)?
            .checked_add(sqlite_shm_growth_bytes)?;
        Some(CapacityDiskMeasurement {
            logical_high_water_upper_bound_bytes, initial_bytes: self.initial_bytes,
            successful_write_bytes, sqlite_file_growth_bytes, sqlite_shm_growth_bytes,
            opened_files, closed_files,
            method: "initial-plus-linux-wchar-plus-sqlite-vfs-positive-growth",
            coverage: "primary child DB, WAL, SHM, rollback journals, unlinked SQLite temp, backup, Restore staging/safety/rollback copies and markers across all filesystems",
            uncertainty: "conservative logical-file-length high-water upper bound; cumulative writes/growth overcount overwrites and nonconcurrent files; excludes filesystem metadata, allocation rounding and KEEP_SIZE preallocation; Linux fresh-child only",
        })
    }
}

impl Drop for DiskMeasurement {
    fn drop(&mut self) {
        ACTIVE.with(|active| *active.borrow_mut() = None);
    }
}

fn original(file: *mut ffi::sqlite3_file) -> Option<ffi::sqlite3_io_methods> {
    let files = FILES.lock().ok()?;
    let meter = files.get(&(file as usize))?;
    // SAFETY: SQLite owns the original static method table; the tracked file
    // cannot close concurrently with a call on that same SQLite handle.
    Some(unsafe { std::ptr::read(meter.original as *const ffi::sqlite3_io_methods) })
}

fn record_size(file: *mut ffi::sqlite3_file, size: u64, shm: bool) {
    if let Ok(mut files) = FILES.lock() {
        if let Some(meter) = files.get_mut(&(file as usize)) {
            let (previous, total) = if shm {
                (&mut meter.shm_size, &meter.counter.shm_growth)
            } else {
                (&mut meter.size, &meter.counter.growth)
            };
            let growth = size.saturating_sub(*previous);
            if total
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_add(growth)
                })
                .is_err()
            {
                meter.counter.failed.store(true, Ordering::Relaxed);
            }
            *previous = size;
        }
    }
}

fn record_io_failure(file: *mut ffi::sqlite3_file, status: c_int) {
    if status != ffi::SQLITE_OK {
        if let Ok(files) = FILES.lock() {
            if let Some(meter) = files.get(&(file as usize)) {
                // Failed IO may have partially extended a file. Do not claim
                // an upper bound when its resulting length is unknown.
                meter.counter.failed.store(true, Ordering::Relaxed);
            }
        }
    }
}

unsafe extern "C" fn open(
    _vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    let Some(parent) = PARENT_VFS.get().copied() else {
        return ffi::SQLITE_CANTOPEN;
    };
    let parent = parent as *mut ffi::sqlite3_vfs;
    // SAFETY: VFS arguments and the parent vtable come from SQLite. Wrappers
    // preserve the platform file layout; only its method-table pointer changes.
    let Some(parent_open) = (unsafe { (*parent).xOpen }) else {
        return ffi::SQLITE_CANTOPEN;
    };
    let status = unsafe { parent_open(parent, name, file, flags, out_flags) };
    if status != ffi::SQLITE_OK {
        return status;
    }
    let counter = ACTIVE.with(|active| active.borrow().as_ref().cloned());
    let Some(counter) = counter else {
        return status;
    };
    let original = unsafe { (*file).pMethods };
    if original.is_null() {
        counter.failed.store(true, Ordering::Relaxed);
        return status;
    }
    let mut methods = Box::new(unsafe { std::ptr::read(original) });
    let mut size = 0;
    if methods
        .xFileSize
        .is_none_or(|size_fn| unsafe { size_fn(file, &mut size) } != ffi::SQLITE_OK)
        || size < 0
    {
        counter.failed.store(true, Ordering::Relaxed);
    }
    methods.xClose = Some(close);
    methods.xWrite = Some(write);
    methods.xTruncate = Some(truncate);
    methods.xFileControl = Some(file_control);
    if methods.iVersion >= 2 && methods.xShmMap.is_some() {
        methods.xShmMap = Some(shm_map);
    }
    let mut files = match FILES.lock() {
        Ok(files) => files,
        Err(_) => {
            counter.failed.store(true, Ordering::Relaxed);
            return status;
        }
    };
    unsafe {
        (*file).pMethods = &*methods;
    }
    counter.opens.fetch_add(1, Ordering::Relaxed);
    files.insert(
        file as usize,
        FileMeter {
            original: original as usize,
            _methods: methods,
            size: size.max(0) as u64,
            shm_size: 0,
            counter,
        },
    );
    status
}

unsafe extern "C" fn close(file: *mut ffi::sqlite3_file) -> c_int {
    let meter = match FILES
        .lock()
        .ok()
        .and_then(|mut files| files.remove(&(file as usize)))
    {
        Some(meter) => meter,
        None => return ffi::SQLITE_IOERR_CLOSE,
    };
    let original = meter.original as *const ffi::sqlite3_io_methods;
    unsafe {
        (*file).pMethods = original;
    }
    let status = match unsafe { (*original).xClose } {
        Some(close) => unsafe { close(file) },
        None => ffi::SQLITE_IOERR_CLOSE,
    };
    if status != ffi::SQLITE_OK {
        meter.counter.failed.store(true, Ordering::Relaxed);
    }
    meter.counter.closes.fetch_add(1, Ordering::Relaxed);
    status
}

unsafe extern "C" fn write(
    file: *mut ffi::sqlite3_file,
    buffer: *const c_void,
    count: c_int,
    offset: i64,
) -> c_int {
    let Some(write) = original(file).and_then(|methods| methods.xWrite) else {
        return ffi::SQLITE_IOERR_WRITE;
    };
    let status = unsafe { write(file, buffer, count, offset) };
    record_io_failure(file, status);
    if status == ffi::SQLITE_OK && count >= 0 && offset >= 0 {
        // xWrite can overwrite earlier pages. Never shrink the tracked size.
        let previous = FILES
            .lock()
            .ok()
            .and_then(|files| files.get(&(file as usize)).map(|meter| meter.size))
            .unwrap_or(0);
        record_size(
            file,
            previous.max((offset as u64).saturating_add(count as u64)),
            false,
        );
    }
    status
}

fn record_actual_size(file: *mut ffi::sqlite3_file, methods: &ffi::sqlite3_io_methods) {
    let mut size = 0;
    if methods.xFileSize.is_some_and(|size_fn| unsafe { size_fn(file, &mut size) } == ffi::SQLITE_OK)
        && size >= 0
    {
        record_size(file, size as u64, false);
    } else {
        record_io_failure(file, ffi::SQLITE_IOERR_FSTAT);
    }
}

unsafe extern "C" fn truncate(file: *mut ffi::sqlite3_file, size: i64) -> c_int {
    let Some(methods) = original(file) else { return ffi::SQLITE_IOERR_TRUNCATE; };
    let Some(truncate) = methods.xTruncate else { return ffi::SQLITE_IOERR_TRUNCATE; };
    let status = unsafe { truncate(file, size) };
    record_io_failure(file, status);
    if status == ffi::SQLITE_OK {
        // The platform VFS may round truncation up to its configured chunk
        // size. The requested length alone is not a file-growth bound.
        record_actual_size(file, &methods);
    }
    status
}

unsafe extern "C" fn file_control(
    file: *mut ffi::sqlite3_file,
    op: c_int,
    arg: *mut c_void,
) -> c_int {
    let Some(methods) = original(file) else {
        return ffi::SQLITE_IOERR;
    };
    let status = match methods.xFileControl {
        Some(control) => unsafe { control(file, op, arg) },
        None => ffi::SQLITE_NOTFOUND,
    };
    if op == ffi::SQLITE_FCNTL_SIZE_HINT {
        if status == ffi::SQLITE_OK {
            record_actual_size(file, &methods);
        } else if status != ffi::SQLITE_NOTFOUND {
            record_io_failure(file, status);
        }
    }
    status
}

unsafe extern "C" fn shm_map(
    file: *mut ffi::sqlite3_file,
    page: c_int,
    page_size: c_int,
    extend: c_int,
    output: *mut *mut c_void,
) -> c_int {
    let Some(map) = original(file).and_then(|methods| methods.xShmMap) else {
        return ffi::SQLITE_IOERR_SHMMAP;
    };
    let status = unsafe { map(file, page, page_size, extend, output) };
    record_io_failure(file, status);
    if status == ffi::SQLITE_OK && page >= 0 && page_size > 0 && !unsafe { *output }.is_null() {
        record_size(
            file,
            (page as u64 + 1).saturating_mul(page_size as u64),
            true,
        );
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn chunk_rounded_truncate_counts_actual_logical_growth() -> Result<()> {
        let directory = std::env::temp_dir().join(format!("grimodex-chunk-truncate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory)?;
        let path = directory.join("input.db");
        let conn = Connection::open(&path)?;
        conn.execute_batch("CREATE TABLE seed(id INTEGER)")?;
        drop(conn);
        let before = std::fs::metadata(&path)?.len();
        let measurement = DiskMeasurement::start(&path)?;
        let conn = Connection::open(&path)?;
        // SAFETY: SQLite owns this live connection/file; the test makes no
        // concurrent calls and retains the connection through both controls.
        unsafe {
            let mut chunk: c_int = 1024 * 1024;
            assert_eq!(ffi::sqlite3_file_control(conn.handle(), c"main".as_ptr(),
                ffi::SQLITE_FCNTL_CHUNK_SIZE, (&mut chunk as *mut c_int).cast()), ffi::SQLITE_OK);
            let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
            assert_eq!(ffi::sqlite3_file_control(conn.handle(), c"main".as_ptr(),
                ffi::SQLITE_FCNTL_FILE_POINTER, (&mut file as *mut *mut ffi::sqlite3_file).cast()), ffi::SQLITE_OK);
            assert!(!file.is_null());
            assert_eq!(((*(*file).pMethods).xTruncate.unwrap())(file, before as i64 + 1), ffi::SQLITE_OK);
        }
        let after = std::fs::metadata(&path)?.len();
        assert_eq!(after, 1024 * 1024);
        drop(conn);
        let disk = measurement.finish().context("closed file bound")?;
        assert!(disk.sqlite_file_growth_bytes >= after - before);
        drop(measurement);
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn disk_bound_covers_wal_journal_temp_and_restore_style_copies() -> Result<()> {
        let root = std::env::temp_dir().join(format!("nir1-disk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let path = root.join("input.db");
        let baseline = Connection::open(&path)?;
        baseline.execute_batch(
            "CREATE TABLE input(body BLOB); INSERT INTO input VALUES(zeroblob(4096))",
        )?;
        drop(baseline);
        let measurement = DiskMeasurement::start(&path)?;
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=4;
            BEGIN; INSERT INTO input VALUES(zeroblob(1048576)); COMMIT;
            CREATE TEMP TABLE spill(body BLOB);
            WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t WHERE n<1024)
            INSERT INTO spill SELECT zeroblob(4096) FROM t;",
        )?;
        let mut observed = std::fs::read_dir(&root)?.try_fold(0u64, |sum, entry| -> Result<_> {
            Ok(sum + entry?.metadata()?.len())
        })?;
        let snapshot = root.join("backup.db");
        conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])?;
        std::fs::copy(&snapshot, root.join("restore-staging.db"))?;
        std::fs::copy(&snapshot, root.join("safety.db"))?;
        std::fs::copy(&snapshot, root.join("rollback.db"))?;
        observed += std::fs::metadata(&snapshot)?.len() * 4;
        assert!(
            measurement.finish().is_none(),
            "live SQLite handles cannot establish complete coverage"
        );
        conn.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; BEGIN;
            UPDATE input SET body=zeroblob(524288);",
        )?;
        assert!(std::fs::metadata(format!("{}-journal", path.display()))?.len() > 0);
        conn.execute_batch("ROLLBACK")?;
        drop(conn);
        let disk = measurement.finish().context("complete disk accounting")?;
        assert!(disk.logical_high_water_upper_bound_bytes >= observed);
        assert!(
            disk.sqlite_file_growth_bytes > 4 * 1024 * 1024,
            "unlinked TEMP spill must be counted"
        );
        assert!(disk.sqlite_shm_growth_bytes >= 32768);
        assert!(
            disk.successful_write_bytes >= std::fs::metadata(&snapshot)?.len() * 3,
            "kernel file copies must be accounted"
        );
        assert_eq!(disk.opened_files, disk.closed_files);
        drop(measurement);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
