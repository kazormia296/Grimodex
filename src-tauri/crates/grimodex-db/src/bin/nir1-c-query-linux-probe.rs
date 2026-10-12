//! Linux /3 diagnostic only. The verified service bootstrap execs this in the
//! same PID/unit; systemd, never this process, retires the runtime directory.

#[cfg(target_os = "linux")]
#[path = "support/c_query_allocation_cases.rs"]
mod c_query_allocation_cases;
#[cfg(target_os = "linux")]
#[path = "support/c_query_allocator.rs"]
mod c_query_allocator;
#[cfg(target_os = "linux")]
#[path = "support/c_query_probe_frame.rs"]
mod c_query_probe_frame;
#[cfg(all(target_os = "linux", not(test)))]
#[path = "support/private_fixture.rs"]
#[allow(dead_code)] // The unchanged legacy CLI uses the other support entrypoints.
mod private_fixture;
#[cfg(all(target_os = "linux", not(test)))]
#[global_allocator]
static C_QUERY_SHARED_ALLOCATOR: c_query_allocator::SharedAllocator =
    c_query_allocator::SharedAllocator;

fn main() -> std::process::ExitCode {
    // Neither anyhow chains nor panic payloads may reach the parent's pipes.
    std::panic::set_hook(Box::new(|_| {}));
    #[cfg(all(target_os = "linux", not(test)))]
    let status = diagnostic_exit_status(linux::run);
    #[cfg(any(not(target_os = "linux"), test))]
    let status = 1;
    std::process::ExitCode::from(status)
}

#[cfg(target_os = "linux")]
fn diagnostic_exit_status(
    operation: impl FnOnce(&std::cell::Cell<u8>) -> anyhow::Result<()>,
) -> u8 {
    // Last entered checkpoint, not a cause or a measurement. A signal/abort may
    // bypass this entirely. No error chain, path or panic payload is serialized.
    let phase = std::cell::Cell::new(64);
    // Only this u8 is inspected after unwinding; no failed operation is resumed.
    if matches!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operation(&phase))),
        Ok(Ok(()))
    ) {
        0
    } else {
        phase.get().max(1)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn failure_status_records_checkpoint_without_promoting_errors() {
        assert_eq!(super::diagnostic_exit_status(|_| Ok(())), 0);
        assert_eq!(
            super::diagnostic_exit_status(|phase| {
                phase.set(73);
                anyhow::bail!("synthetic private error must not become output")
            }),
            73
        );
        assert_eq!(
            super::diagnostic_exit_status(|phase| {
                phase.set(67);
                panic!("synthetic private panic must not become output")
            }),
            67
        );
        assert_ne!(
            super::diagnostic_exit_status(|phase| {
                phase.set(0);
                anyhow::bail!("failure is never exit zero")
            }),
            0
        );
    }
}

#[cfg(all(target_os = "linux", not(test)))]
mod linux {
    use std::{
        cell::RefCell,
        ffi::CString,
        fs::{self, File, OpenOptions},
        io::{Read, Seek, SeekFrom, Write},
        os::{
            fd::{AsRawFd, FromRawFd, RawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };

    use super::{
        c_query_allocation_cases::{self, FixedAllocatorCase},
        c_query_allocator,
        c_query_probe_frame::{
            encode_allocation_case, encode_graph_observation, GraphObservation, QueryStatus,
        },
        private_fixture,
    };
    use anyhow::{ensure, Result};

    // Must match the benign owner's unit binding; runtime name is intentionally different.
    const UNIT_PREFIX: &str = "nir1-c-query-host-smoke-";
    const RUNTIME_PREFIX: &str = "nir1-c-query-probe-";

    pub fn run(phase: &std::cell::Cell<u8>) -> Result<()> {
        // This local I/O cutoff cannot extend the manager's already-running TTL
        // or the parent's earlier absolute cutoff. It is never renewed at READY.
        let io_deadline = Instant::now() + Duration::from_secs(115);
        phase.set(64); // Core-dump protections precede fixture/case work.
        verify_core_dump_policy()?;
        let mut args = std::env::args_os().skip(1);
        let case_arg = args.next().ok_or_else(|| anyhow::anyhow!("case missing"))?;
        ensure!(args.next().is_none(), "unexpected arguments");
        enum Case {
            Graph(&'static str, u16),
            Allocator(FixedAllocatorCase),
        }
        let case = match case_arg.to_str() {
            Some(private_fixture::CASE_ID) => Case::Graph(private_fixture::CASE_ID, 513),
            Some(private_fixture::LOCAL_CASE_ID) => Case::Graph(private_fixture::LOCAL_CASE_ID, 2),
            Some(value) => Case::Allocator(
                c_query_allocation_cases::parse_case(value)
                    .ok_or_else(|| anyhow::anyhow!("case invalid"))?,
            ),
            None => anyhow::bail!("case invalid"),
        };
        phase.set(65); // Credentials.
                       // SAFETY: reads process credentials without changing them.
        let uid = unsafe { libc::geteuid() };
        ensure!(uid != 0, "root unsupported");
        phase.set(66); // Inherited pipes.
        verify_pipes(uid)?;
        phase.set(67); // Cgroup binding, limits and sole process.
        let (cgroup, nonce) = own_cgroup(uid)?;
        phase.set(68); // Runtime directory ancestry and emptiness.
        let runtime_path = PathBuf::from(format!("/run/user/{uid}/{RUNTIME_PREFIX}{nonce}"));
        let runtime_fd = runtime_directory(&runtime_path, uid)?;
        ensure!(
            fs::read_dir(&runtime_path)?.next().is_none(),
            "runtime not empty"
        );
        phase.set(69); // Open/sample cgroup counters, before any fixture work.
        let mut memory = Memory::open(&cgroup)?;
        let startup = memory.sample()?;
        phase.set(70); // Umask, held runtime identity, then callback installation.
                       // SAFETY: this isolated binary is single threaded before fixture setup.
        let old_mask = unsafe { libc::umask(0o077) };
        ensure!(old_mask == 0o077, "unexpected umask");
        verify_runtime_identity(&runtime_path, &runtime_fd, uid)?;
        c_query_allocator::install_sqlite_allocator()
            .map_err(|_| anyhow::anyhow!("SQLite allocator installation failed"))?;

        let memory = RefCell::new(memory);
        match case {
            Case::Allocator(case) => {
                phase.set(71); // SQLite baseline initialization and fixed baseline blocks.
                let baseline = c_query_allocation_cases::CaseBaseline::prepare(case)?;
                phase.set(81); // Data-free ARMED/CONTINUE; never Graph registration.
                verify_runtime_identity(&runtime_path, &runtime_fd, uid)?;
                armed_continue(&nonce, io_deadline)?;
                phase.set(82); // One irreversible epoch before any fixed case operation.
                c_query_allocator::begin_epoch()
                    .map_err(|_| anyhow::anyhow!("allocator epoch start failed"))?;
                let at_epoch = c_query_allocator::snapshot();
                if case == FixedAllocatorCase::RustLimit {
                    phase.set(83);
                    c_query_allocation_cases::run_rust_limit_case(baseline, at_epoch);
                }
                phase.set(83); // Fixed allocation/copy/free assertions.
                let outcome = c_query_allocation_cases::run_framed_case(case, baseline, at_epoch)?;
                verify_runtime_identity(&runtime_path, &runtime_fd, uid)?;
                phase.set(86);
                let frame = encode_allocation_case(outcome)
                    .ok_or_else(|| anyhow::anyhow!("allocation frame rejected"))?;
                phase.set(87);
                write_pipe_frame(frame.as_bytes(), io_deadline)
            }
            Case::Graph(case_id, case_code) => {
                let registered = RefCell::new(None);
                let cgroup_baseline = RefCell::new(None);
                let query_cgroup = RefCell::new(None);
                let shared_at_epoch = RefCell::new(None);
                let shared_after_query = RefCell::new(None);
                let observation = private_fixture::run_managed_fixture(
                    case_id,
                    &runtime_path,
                    |value| phase.set(value),
                    || {
                        phase.set(82); // Admission begins after READY, before request strings.
                        let rust_baseline = c_query_allocator::begin_epoch()
                            .map_err(|_| anyhow::anyhow!("allocator epoch start failed"))?;
                        *shared_at_epoch.borrow_mut() = Some(c_query_allocator::snapshot());
                        // Cgroup reset follows epoch start so all later Rust allocations count.
                        *cgroup_baseline.borrow_mut() = Some(memory.borrow_mut().reset()?);
                        Ok(rust_baseline)
                    },
                    || {
                        phase.set(83); // Query-boundary shared snapshot, before cleanup.
                        let shared = c_query_allocator::snapshot();
                        *shared_after_query.borrow_mut() = Some(shared);
                        *query_cgroup.borrow_mut() = Some(memory.borrow_mut().sample()?);
                        Ok((
                            shared.rust_requested_live_bytes,
                            shared.rust_requested_peak_bytes,
                        ))
                    },
                    || {
                        phase.set(79); // Registered-idle cgroup sample.
                        *registered.borrow_mut() = Some(memory.borrow_mut().sample()?);
                        phase.set(80); // Runtime identity after registration.
                        verify_runtime_identity(&runtime_path, &runtime_fd, uid)?;
                        phase.set(81); // Registered Graph READY/CONTINUE handshake.
                        ready_continue(&nonce, io_deadline)
                    },
                )?;
                phase.set(84); // Explicit reader/source cleanup checks.
                ensure!(
                    observation.registration.registered
                        && observation.cleanup.reader_closed
                        && observation.cleanup.workspace_participant_released
                        && observation.source_snapshot_verified_unchanged
                        && !observation.cleanup.disposable_database_removed,
                    "diagnostic cleanup incomplete"
                );
                verify_runtime_identity(&runtime_path, &runtime_fd, uid)?;
                phase.set(85); // Required samples and fixed facts.
                let registered = registered
                    .into_inner()
                    .ok_or_else(|| anyhow::anyhow!("registered sample missing"))?;
                let cgroup_baseline = cgroup_baseline
                    .into_inner()
                    .ok_or_else(|| anyhow::anyhow!("reset missing"))?;
                let (cgroup_after, cgroup_peak) = query_cgroup
                    .into_inner()
                    .ok_or_else(|| anyhow::anyhow!("query sample missing"))?;
                ensure!(
                    cgroup_peak >= cgroup_baseline && cgroup_peak >= cgroup_after,
                    "query peak inconsistent"
                );
                let at_epoch = shared_at_epoch
                    .into_inner()
                    .ok_or_else(|| anyhow::anyhow!("epoch snapshot missing"))?;
                let after_query = shared_after_query
                    .into_inner()
                    .ok_or_else(|| anyhow::anyhow!("query snapshot missing"))?;
                let stage = &observation.query.stage_observation;
                let reached = [
                    stage.pre_snapshot_identity_seal_ns.is_some(),
                    stage.indexed_candidate_page_ns.is_some(),
                    stage.a2_preflight_ns.is_some(),
                    stage.a2_sql.length_ns.is_some(),
                    stage.a3_preflight_ns.is_some(),
                    stage.a3_sql.timings_ns[0].is_some(),
                    stage.a3_evaluation_ns.is_some(),
                    stage.cleanup_post_stamp_ns.is_some(),
                ];
                let failed = [
                    stage.work_result_error,
                    stage.post_stamp_error,
                    stage.deadline_observed_at_collapse,
                    stage.unattributed,
                ];
                let query_status = match observation.query.status {
                    "available" => QueryStatus::Available,
                    "unavailable" => QueryStatus::Unavailable,
                    "error" => QueryStatus::Error,
                    _ => anyhow::bail!("unknown query status"),
                };
                let query_elapsed_ns_approx = approximate_ns(observation.query.elapsed_ms)?;
                let close_elapsed_ns_approx = approximate_ns(observation.cleanup.elapsed_ms)?;
                let rust_baseline_requested_live_bytes =
                    observation.rust_allocator.baseline_requested_live_bytes;
                let rust_query_requested_live_peak_bytes = observation
                    .rust_allocator
                    .query_window_peak_requested_live_bytes;
                let rust_query_requested_live_after_bytes =
                    observation.rust_allocator.requested_live_bytes_after_query;
                let sqlite_baseline_memory_used_bytes = observation.sqlite.baseline_bytes;
                let sqlite_query_memory_used_peak_bytes =
                    observation.sqlite.query_window_highwater_bytes;
                let sqlite_query_memory_used_after_bytes =
                    observation.sqlite.current_bytes_after_query;
                let (sqlite_registered_authority, sqlite_registered_reader) = observation
                    .sqlite_registered_connections
                    .ok_or_else(|| anyhow::anyhow!("registered SQLite samples missing"))?;
                let (query_reached_mask, query_failure_mask) = (mask(&reached), mask(&failed));
                let graph_facts = (
                    observation.registration.registered,
                    observation.cleanup.reader_closed,
                    observation.cleanup.workspace_participant_released,
                    observation.source_snapshot_verified_unchanged,
                    !observation.cleanup.disposable_database_removed,
                );
                // Keep accounting armed after cleanup and through frame construction/write.
                drop(observation);
                let after_graph_cleanup_and_observation_drop = c_query_allocator::snapshot();
                phase.set(86);
                let frame = encode_graph_observation(GraphObservation {
                    case_code,
                    query_elapsed_ns_approx,
                    close_elapsed_ns_approx,
                    cgroup_startup_bytes: startup.0,
                    cgroup_startup_lifetime_peak_bytes: startup.1,
                    cgroup_registered_bytes: registered.0,
                    cgroup_registered_lifetime_peak_bytes: registered.1,
                    cgroup_query_baseline_bytes: cgroup_baseline,
                    cgroup_query_peak_bytes: cgroup_peak,
                    cgroup_query_after_bytes: cgroup_after,
                    query_reached_mask,
                    query_failure_mask,
                    rust_baseline_requested_live_bytes,
                    rust_query_requested_live_peak_bytes,
                    rust_query_requested_live_after_bytes,
                    sqlite_baseline_memory_used_bytes,
                    sqlite_query_memory_used_peak_bytes,
                    sqlite_query_memory_used_after_bytes,
                    sqlite_registered_authority,
                    sqlite_registered_reader,
                    query_status,
                    at_epoch,
                    after_query,
                    after_graph_cleanup_and_observation_drop,
                    registered_ready_observed: graph_facts.0,
                    reader_closed: graph_facts.1,
                    participant_released: graph_facts.2,
                    source_unchanged: graph_facts.3,
                    files_retained: graph_facts.4,
                    cgroup_peak_reset: true,
                })
                .ok_or_else(|| anyhow::anyhow!("Graph frame rejected"))?;
                phase.set(87);
                write_pipe_frame(frame.as_bytes(), io_deadline)
            }
        }
    }

    fn verify_core_dump_policy() -> Result<()> {
        let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
        // SAFETY: getrlimit initializes the valid output object on success.
        ensure!(
            unsafe { libc::getrlimit(libc::RLIMIT_CORE, limit.as_mut_ptr()) } == 0,
            "core limit query failed"
        );
        // SAFETY: getrlimit succeeded above.
        let limit = unsafe { limit.assume_init() };
        ensure!(
            limit.rlim_cur == 0 && limit.rlim_max == 0,
            "core limit is not zero"
        );
        // SAFETY: prctl uses scalar arguments and does not retain pointers.
        ensure!(
            unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } == 0,
            "disable dumpability failed"
        );
        // SAFETY: PR_GET_DUMPABLE returns the current scalar process state.
        ensure!(
            unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) } == 0,
            "process remains dumpable"
        );
        Ok(())
    }

    fn mask(bits: &[bool]) -> u8 {
        bits.iter()
            .enumerate()
            .fold(0, |mask, (bit, set)| mask | (u8::from(*set) << bit))
    }

    fn approximate_ns(ms: f64) -> Result<u64> {
        let ns = ms * 1_000_000.0;
        ensure!(
            ns.is_finite() && ns >= 0.0 && ns < u64::MAX as f64,
            "elapsed invalid"
        );
        Ok(ns as u64)
    }

    fn read_bounded<'a>(file: &mut File, buffer: &'a mut [u8]) -> Result<&'a [u8]> {
        let mut len = 0;
        loop {
            ensure!(len < buffer.len(), "input too long");
            match file.read(&mut buffer[len..]) {
                Ok(0) => return Ok(&buffer[..len]),
                Ok(n) => len += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }

    fn own_cgroup(uid: u32) -> Result<(PathBuf, String)> {
        let mut bytes = [0; 4097];
        let raw = read_bounded(&mut File::open("/proc/self/cgroup")?, &mut bytes)?;
        let line = std::str::from_utf8(raw)?;
        let prefix =
            format!("0::/user.slice/user-{uid}.slice/user@{uid}.service/app.slice/{UNIT_PREFIX}");
        let nonce = line
            .strip_prefix(&prefix)
            .and_then(|s| s.strip_suffix(".service\n"))
            .ok_or_else(|| anyhow::anyhow!("unit binding invalid"))?;
        ensure!(
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "nonce invalid"
        );
        let path =
            Path::new("/sys/fs/cgroup").join(line[4..line.len() - 1].trim_start_matches('/'));
        // No symlink ancestry; require the real cgroup-v2 filesystem.
        let directory = open_directory_chain(&path)?;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: a live directory fd and writable statfs storage.
        ensure!(
            unsafe { libc::fstatfs(directory.as_raw_fd(), stat.as_mut_ptr()) } == 0,
            "cgroup stat failed"
        );
        // SAFETY: successful fstatfs initialized the storage.
        ensure!(
            unsafe { stat.assume_init() }.f_type == libc::CGROUP2_SUPER_MAGIC,
            "not cgroup v2"
        );
        ensure!(
            read_number_path(&path.join("memory.max"))? == 67_108_864
                && read_number_path(&path.join("memory.swap.max"))? == 0,
            "limits invalid"
        );
        let mut procs = [0; 64];
        let raw = read_bounded(&mut File::open(path.join("cgroup.procs"))?, &mut procs)?;
        ensure!(
            raw == format!("{}\n", std::process::id()).as_bytes(),
            "not sole unit process"
        );
        Ok((path, nonce.to_owned()))
    }

    fn open_child_directory(parent: &File, name: &str) -> Result<File> {
        let name = CString::new(name)?;
        // SAFETY: NUL-terminated component and live parent fd; successful fd is owned below.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        ensure!(fd >= 0, "directory open failed");
        // SAFETY: uniquely own the newly opened descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_directory_chain(path: &Path) -> Result<File> {
        let mut directory = File::open("/")?;
        for component in path.components().skip(1) {
            let std::path::Component::Normal(name) = component else {
                anyhow::bail!("invalid directory component")
            };
            directory = open_child_directory(
                &directory,
                name.to_str()
                    .ok_or_else(|| anyhow::anyhow!("non-ascii directory"))?,
            )?;
        }
        Ok(directory)
    }

    fn runtime_directory(path: &Path, uid: u32) -> Result<File> {
        let mut directory = File::open("/")?;
        let components = [
            "run".to_owned(),
            "user".to_owned(),
            uid.to_string(),
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| anyhow::anyhow!("runtime name"))?
                .to_owned(),
        ];
        for (index, component) in components.iter().enumerate() {
            directory = open_child_directory(&directory, component)?;
            let info = directory.metadata()?;
            ensure!(
                if index < 2 {
                    info.uid() == 0 && info.mode() & 0o022 == 0
                } else {
                    info.uid() == uid && info.mode() & 0o7777 == 0o700
                },
                "runtime ancestry invalid"
            );
        }
        Ok(directory)
    }

    fn verify_runtime_identity(path: &Path, held: &File, uid: u32) -> Result<()> {
        let now = runtime_directory(path, uid)?.metadata()?;
        let before = held.metadata()?;
        ensure!(
            now.dev() == before.dev() && now.ino() == before.ino() && now.nlink() > 0,
            "runtime identity changed"
        );
        Ok(())
    }

    fn read_number_path(path: &Path) -> Result<u64> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        read_number(&mut file)
    }

    fn read_number(file: &mut File) -> Result<u64> {
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = [0; 32];
        let raw = read_bounded(file, &mut bytes)?;
        let digits = raw
            .strip_suffix(b"\n")
            .ok_or_else(|| anyhow::anyhow!("counter format"))?;
        ensure!(
            !digits.is_empty() && digits.iter().all(u8::is_ascii_digit),
            "counter invalid"
        );
        Ok(std::str::from_utf8(digits)?.parse()?)
    }

    struct Memory {
        current: File,
        peak: File,
    }
    impl Memory {
        fn open(path: &Path) -> Result<Self> {
            Ok(Self {
                current: OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(path.join("memory.current"))?,
                peak: OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(path.join("memory.peak"))?,
            })
        }
        fn sample(&mut self) -> Result<(u64, u64)> {
            Ok((
                read_number(&mut self.current)?,
                read_number(&mut self.peak)?,
            ))
        }
        fn reset(&mut self) -> Result<u64> {
            self.peak.seek(SeekFrom::Start(0))?;
            // Linux memory.peak reset is fd-local. Never reopen this fd after reset.
            ensure!(self.peak.write(b"0")? == 1, "peak reset failed");
            let (current, peak) = self.sample()?;
            ensure!(peak >= current, "peak reset read failed");
            Ok(current)
        }
    }

    fn verify_pipes(uid: u32) -> Result<()> {
        let mut identities = [(0, 0); 2];
        for fd in [0, 1] {
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: fstat writes to valid storage for an inherited fd.
            ensure!(
                unsafe { libc::fstat(fd, stat.as_mut_ptr()) } == 0,
                "pipe stat failed"
            );
            // SAFETY: successful fstat initialized storage.
            let stat = unsafe { stat.assume_init() };
            ensure!(
                stat.st_mode & libc::S_IFMT == libc::S_IFIFO && stat.st_uid == uid,
                "pipe shape invalid"
            );
            let target = fs::read_link(format!("/proc/self/fd/{fd}"))?;
            ensure!(
                target.to_str() == Some(format!("pipe:[{}]", stat.st_ino).as_str()),
                "not anonymous pipe"
            );
            identities[fd as usize] = (stat.st_dev, stat.st_ino);
            // SAFETY: descriptor flag operations do not access memory.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            ensure!(
                flags >= 0
                    && flags & libc::O_ACCMODE
                        == if fd == 0 {
                            libc::O_RDONLY
                        } else {
                            libc::O_WRONLY
                        },
                "pipe direction invalid"
            );
            // SAFETY: set nonblocking so poll cannot be followed by an unbounded I/O.
            ensure!(
                unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0,
                "pipe flags failed"
            );
        }
        ensure!(identities[0] != identities[1], "pipes alias");
        Ok(())
    }

    fn wait_pipe(fd: RawFd, events: i16, deadline: Instant) -> Result<()> {
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| anyhow::anyhow!("I/O expired"))?;
            let millis = remaining.as_millis().min(i32::MAX as u128) as i32;
            ensure!(millis > 0, "I/O expired");
            let mut pollfd = libc::pollfd {
                fd,
                events,
                revents: 0,
            };
            // SAFETY: valid one-element pollfd array, finite timeout.
            let result = unsafe { libc::poll(&mut pollfd, 1, millis) };
            if result < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            ensure!(
                result > 0 && pollfd.revents & (libc::POLLERR | libc::POLLNVAL) == 0,
                "pipe wait failed"
            );
            ensure!(
                pollfd.revents & (events | libc::POLLHUP) != 0,
                "pipe not ready"
            );
            return Ok(());
        }
    }

    fn write_pipe_frame(bytes: &[u8], deadline: Instant) -> Result<()> {
        ensure!(bytes.len() <= 4096, "frame too long");
        loop {
            wait_pipe(1, libc::POLLOUT, deadline)?;
            // SAFETY: byte slice valid for this write. Linux PIPE_BUF is 4096;
            // nonblocking writes this small are atomic or return EAGAIN.
            let written = unsafe { libc::write(1, bytes.as_ptr().cast(), bytes.len()) };
            if written < 0 {
                let error = std::io::Error::last_os_error();
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) {
                    continue;
                }
                return Err(error.into());
            }
            ensure!(written as usize == bytes.len(), "short pipe write");
            return Ok(());
        }
    }

    fn armed_continue(nonce: &str, deadline: Instant) -> Result<()> {
        let mut armed = [0; 39];
        armed[..6].copy_from_slice(b"ARMED ");
        armed[6..38].copy_from_slice(nonce.as_bytes());
        armed[38] = b'\n';
        write_pipe_frame(&armed, deadline)?;
        read_continue(nonce, deadline)
    }

    fn ready_continue(nonce: &str, deadline: Instant) -> Result<()> {
        let mut ready = [0; 39];
        ready[..6].copy_from_slice(b"READY ");
        ready[6..38].copy_from_slice(nonce.as_bytes());
        ready[38] = b'\n';
        write_pipe_frame(&ready, deadline)?;
        read_continue(nonce, deadline)
    }

    fn read_continue(nonce: &str, deadline: Instant) -> Result<()> {
        let mut expected = [0; 42];
        expected[..9].copy_from_slice(b"CONTINUE ");
        expected[9..41].copy_from_slice(nonce.as_bytes());
        expected[41] = b'\n';
        let mut received = [0; 43];
        let mut len = 0;
        loop {
            wait_pipe(0, libc::POLLIN, deadline)?;
            // SAFETY: remaining buffer is valid and nonempty; stdin nonblocking.
            let count =
                unsafe { libc::read(0, received[len..].as_mut_ptr().cast(), received.len() - len) };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) {
                    continue;
                }
                return Err(error.into());
            }
            if count == 0 {
                break;
            }
            len += count as usize;
            ensure!(
                len <= expected.len() && received[..len] == expected[..len],
                "continuation invalid"
            );
        }
        ensure!(received[..len] == expected, "continuation incomplete");
        Ok(())
    }
}
