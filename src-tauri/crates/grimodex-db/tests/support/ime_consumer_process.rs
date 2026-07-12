use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use grimodex_db::ime_export::{get_status, ImeExportStatus, ImeIntegrationMode};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub fn spawn_and_wait_for_consumer(
    server_env: &str,
    process_label: &str,
    consumer_id: &str,
) -> anyhow::Result<ImeExportStatus> {
    let server = env::var_os(server_env)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .with_context(|| {
            format!(
                "{server_env} must point to the {process_label} executable; \
                 this test is opt-in and must be run with --ignored"
            )
        })?;
    if !server.is_file() {
        bail!("{server_env} is not a file: {}", server.display());
    }

    let sandbox = Sandbox::new(process_label)?;
    let mut process = ServerProcess::spawn(&server, &sandbox, process_label)?;
    let started_at = Instant::now();

    loop {
        if let Some(exit_status) = process.try_wait()? {
            bail!(
                "{} exited before registering {consumer_id}: {exit_status}",
                server.display()
            );
        }

        let status = get_status(&sandbox.ime_root, ImeIntegrationMode::Auto)
            .with_context(|| format!("read Grimodex IME status while polling {process_label}"))?;
        if status
            .consumers
            .iter()
            .any(|consumer| consumer.consumer_id == consumer_id)
        {
            return Ok(status);
        }

        if started_at.elapsed() >= STARTUP_TIMEOUT {
            bail!(
                "timed out after {:?} waiting for {consumer_id}; server={}, ime_root={}",
                STARTUP_TIMEOUT,
                server.display(),
                sandbox.ime_root.display()
            );
        }
        thread::sleep(POLL_INTERVAL);
    }
}

struct Sandbox {
    root: PathBuf,
    ime_root: PathBuf,
    runtime_home: PathBuf,
    data_home: PathBuf,
    config_home: PathBuf,
    state_home: PathBuf,
    cache_home: PathBuf,
    home: PathBuf,
}

impl Sandbox {
    fn new(process_label: &str) -> anyhow::Result<Self> {
        let safe_label: String = process_label
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '-'
                }
            })
            .collect();
        let root = env::temp_dir().join(format!(
            "grimodex-{safe_label}-process-e2e-{}",
            uuid::Uuid::new_v4()
        ));
        let sandbox = Self {
            ime_root: root.join("grimodex-ime"),
            runtime_home: root.join("runtime"),
            data_home: root.join("data"),
            config_home: root.join("config"),
            state_home: root.join("state"),
            cache_home: root.join("cache"),
            home: root.join("home"),
            root,
        };
        for directory in [
            &sandbox.runtime_home,
            &sandbox.data_home,
            &sandbox.config_home,
            &sandbox.state_home,
            &sandbox.cache_home,
            &sandbox.home,
        ] {
            fs::create_dir_all(directory)
                .with_context(|| format!("create E2E directory {}", directory.display()))?;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("make E2E directory private: {}", directory.display()))?;
        }
        Ok(sandbox)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct ServerProcess {
    child: Child,
    process_label: String,
}

impl ServerProcess {
    fn spawn(server: &Path, sandbox: &Sandbox, process_label: &str) -> anyhow::Result<Self> {
        let child = Command::new(server)
            .env("GRIMODEX_IME_ROOT", &sandbox.ime_root)
            .env("GRIMODEX_PROCESS_E2E", "1")
            .env("XDG_RUNTIME_DIR", &sandbox.runtime_home)
            .env("XDG_DATA_HOME", &sandbox.data_home)
            .env("XDG_CONFIG_HOME", &sandbox.config_home)
            .env("XDG_STATE_HOME", &sandbox.state_home)
            .env("XDG_CACHE_HOME", &sandbox.cache_home)
            .env("HOME", &sandbox.home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("start {process_label} {}", server.display()))?;
        Ok(Self {
            child,
            process_label: process_label.to_owned(),
        })
    }

    fn try_wait(&mut self) -> anyhow::Result<Option<std::process::ExitStatus>> {
        self.child
            .try_wait()
            .with_context(|| format!("poll {} process", self.process_label))
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_directories_are_private() {
        let sandbox = Sandbox::new("contract-test").expect("create IME E2E sandbox");
        for directory in [
            &sandbox.runtime_home,
            &sandbox.data_home,
            &sandbox.config_home,
            &sandbox.state_home,
            &sandbox.cache_home,
            &sandbox.home,
        ] {
            let permissions = fs::metadata(directory)
                .expect("read E2E directory metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(permissions, 0o700, "{}", directory.display());
        }
    }
}
