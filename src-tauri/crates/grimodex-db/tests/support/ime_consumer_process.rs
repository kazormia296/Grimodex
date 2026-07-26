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
const PROCESS_E2E_PROJECT_ID: &str = "process-e2e-project";

pub fn spawn_and_wait_for_consumer(
    server_env: &str,
    process_label: &str,
    consumer_id: &str,
) -> anyhow::Result<ImeExportStatus> {
    spawn_and_wait_for_consumer_inner(server_env, process_label, consumer_id, false)
}

#[cfg(target_os = "macos")]
pub fn spawn_and_wait_for_consumer_with_ready_probe(
    server_env: &str,
    process_label: &str,
    consumer_id: &str,
) -> anyhow::Result<ImeExportStatus> {
    spawn_and_wait_for_consumer_inner(server_env, process_label, consumer_id, true)
}

fn spawn_and_wait_for_consumer_inner(
    server_env: &str,
    process_label: &str,
    consumer_id: &str,
    require_ready_probe: bool,
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
    let ready_path = require_ready_probe.then(|| sandbox.root.join("server-ready"));
    let mut process =
        ServerProcess::spawn(&server, &sandbox, process_label, ready_path.as_deref())?;
    let started_at = Instant::now();
    let mut update_installed = !require_ready_probe;

    loop {
        if let Some(exit_status) = process.try_wait()? {
            bail!(
                "{} exited before registering {consumer_id}: {exit_status}",
                server.display()
            );
        }

        let status = get_status(&sandbox.ime_root, ImeIntegrationMode::Auto)
            .with_context(|| format!("read Grimodex IME status while polling {process_label}"))?;
        let consumer_is_ready = status
            .consumers
            .iter()
            .any(|consumer| consumer.consumer_id == consumer_id);
        let process_is_ready = if let Some(path) = ready_path.as_ref() {
            let snapshot = fs::read_to_string(path).unwrap_or_default();
            if !update_installed && snapshot.contains("\t龍星港\t宇宙港の物語") {
                sandbox.install_updated_project()?;
                update_installed = true;
                false
            } else {
                update_installed && snapshot.contains("\t新龍星港\t更新後")
            }
        } else {
            true
        };
        if consumer_is_ready && process_is_ready {
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
            &sandbox.ime_root,
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
        let projects = sandbox.ime_root.join("projects");
        fs::create_dir_all(&projects)
            .with_context(|| format!("create E2E projects directory {}", projects.display()))?;
        fs::set_permissions(&projects, fs::Permissions::from_mode(0o700)).with_context(|| {
            format!(
                "make E2E projects directory private: {}",
                projects.display()
            )
        })?;
        fs::write(
            sandbox.ime_root.join("state.json"),
            format!(
                "{{\"format_version\":1,\"active_project_id\":\"{PROCESS_E2E_PROJECT_ID}\",\"updated_at\":\"2026-07-12T00:00:00.000Z\"}}"
            ),
        )
        .context("write process E2E state fixture")?;
        sandbox.install_project("龍星港", "宇宙港の物語", false)?;
        Ok(sandbox)
    }

    fn install_updated_project(&self) -> anyhow::Result<()> {
        self.install_project("新龍星港", "更新後", true)
    }

    fn install_project(&self, surface: &str, topic: &str, atomic: bool) -> anyhow::Result<()> {
        let projects = self.ime_root.join("projects");
        let destination = projects.join(format!("{PROCESS_E2E_PROJECT_ID}.json"));
        let data = format!(
            "{{\"format_version\":1,\"project_id\":\"{PROCESS_E2E_PROJECT_ID}\",\"project_name\":\"星海年代記\",\"generated_at\":\"2026-07-12T00:00:00.000Z\",\"entries\":[{{\"yomi\":\"りゅうせいこう\",\"surface\":\"{surface}\",\"category\":\"place\",\"priority\":2,\"entry_id\":\"entry-port\"}}],\"zenzai_context\":{{\"topic\":\"{topic}\",\"style\":null,\"preference\":null}}}}"
        );
        if atomic {
            let temporary = projects.join(".process-e2e-project.tmp");
            fs::write(&temporary, data).context("write updated process E2E project fixture")?;
            fs::rename(&temporary, &destination)
                .context("atomically replace process E2E project fixture")?;
        } else {
            fs::write(destination, data).context("write process E2E project fixture")?;
        }
        Ok(())
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
    fn spawn(
        server: &Path,
        sandbox: &Sandbox,
        process_label: &str,
        ready_path: Option<&Path>,
    ) -> anyhow::Result<Self> {
        let mut command = Command::new(server);
        command
            .env("GRIMODEX_IME_ROOT", &sandbox.ime_root)
            .env("GRIMODEX_PROCESS_E2E", "1")
            .env(
                "GRIMODEX_PROCESS_E2E_EXPECT_PROJECT_ID",
                PROCESS_E2E_PROJECT_ID,
            )
            .env("XDG_RUNTIME_DIR", &sandbox.runtime_home)
            .env("XDG_DATA_HOME", &sandbox.data_home)
            .env("XDG_CONFIG_HOME", &sandbox.config_home)
            .env("XDG_STATE_HOME", &sandbox.state_home)
            .env("XDG_CACHE_HOME", &sandbox.cache_home)
            .env("HOME", &sandbox.home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if let Some(ready_path) = ready_path {
            command.env("GRIMODEX_PROCESS_E2E_READY", ready_path);
        }
        let child = command
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
            &sandbox.ime_root,
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
