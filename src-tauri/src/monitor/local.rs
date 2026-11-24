use super::{MonitorParser, MonitorSample, SCRIPT};
use crate::ui_error::{ui_code, ui_err};
use std::{
    collections::HashMap,
    io::{self, Read},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
use tauri::{State, ipc::Channel};

#[cfg(windows)]
#[path = "windows.rs"]
mod windows;

#[derive(Default)]
pub(crate) struct LocalMonitors(Mutex<HashMap<u32, LocalTask>>);

struct LocalTask {
    stop: mpsc::Sender<()>,
    done: mpsc::Receiver<()>,
}

impl LocalTask {
    fn spawn(run: impl FnOnce(mpsc::Receiver<()>) + Send + 'static) -> io::Result<Self> {
        let (stop, stopped) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        thread::Builder::new()
            .name("local-monitor".into())
            .spawn(move || {
                // Disconnect the completion receiver even if sampling unwinds.
                let _finished = finished;
                run(stopped);
            })?;
        Ok(Self { stop, done })
    }

    fn request_stop(&self) {
        let _ = self.stop.send(());
    }

    fn wait_until(&self, deadline: Instant) -> bool {
        !matches!(
            self.done
                .recv_timeout(deadline.saturating_duration_since(Instant::now())),
            Err(mpsc::RecvTimeoutError::Timeout)
        )
    }
}

impl LocalMonitors {
    pub(crate) fn stop_all(&self) {
        let mut tasks = self.0.lock().unwrap_or_else(|err| err.into_inner());
        Self::stop_tasks(&mut tasks);
    }

    fn stop(tasks: &mut HashMap<u32, LocalTask>, tab_id: u32) -> Result<(), String> {
        if let Some(task) = tasks.get(&tab_id) {
            task.request_stop();
            if !task.wait_until(Instant::now() + Duration::from_millis(2500)) {
                return Err(ui_code("MONITOR_STOP_TIMEOUT").into());
            }
            tasks.remove(&tab_id);
        }
        Ok(())
    }

    fn stop_tasks(tasks: &mut HashMap<u32, LocalTask>) {
        for task in tasks.values() {
            task.request_stop();
        }
        let deadline = Instant::now() + Duration::from_millis(2500);
        for task in tasks.values() {
            task.wait_until(deadline);
        }
        tasks.clear();
    }
}

impl Drop for LocalMonitors {
    fn drop(&mut self) {
        Self::stop_tasks(self.0.get_mut().unwrap_or_else(|err| err.into_inner()));
    }
}

#[tauri::command]
pub async fn local_monitor_start(
    state: State<'_, Arc<LocalMonitors>>,
    tab_id: u32,
    wsl: bool,
    wsl_distro: Option<String>,
    on_sample: Channel<MonitorSample>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut tasks = state.0.lock().unwrap_or_else(|err| err.into_inner());
        LocalMonitors::stop(&mut tasks, tab_id)?;
        // Reap finished entries, including tabs whose channel closed before an explicit stop.
        tasks.retain(|_, task| !task.wait_until(Instant::now()));
        let (task, _) = start_source(wsl, wsl_distro.as_deref(), move |sample| {
            on_sample.send(sample).is_ok()
        })?;
        tasks.insert(tab_id, task);
        Ok(())
    })
    .await
    .map_err(start_failed)?
}

#[tauri::command]
pub async fn local_monitor_stop(
    state: State<'_, Arc<LocalMonitors>>,
    tab_id: u32,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut tasks = state.0.lock().unwrap_or_else(|err| err.into_inner());
        LocalMonitors::stop(&mut tasks, tab_id)
    })
    .await
    .map_err(|err| ui_err("MONITOR_STOP_FAILED").detail(err))?
}

fn start_failed(error: impl std::fmt::Display) -> String {
    ui_err("MONITOR_START_FAILED").detail(error).into()
}

fn start_source(
    wsl: bool,
    distro: Option<&str>,
    send: impl FnMut(MonitorSample) -> bool + Send + 'static,
) -> Result<(LocalTask, Option<u32>), String> {
    #[cfg(not(windows))]
    if wsl {
        return Err(ui_code("MONITOR_WSL_WINDOWS_ONLY").into());
    }
    if wsl
        && distro.is_some_and(|name| {
            name.is_empty()
                || name.starts_with('-')
                || name.chars().count() > 64
                || name.chars().any(|c| c.is_whitespace() || c.is_control())
        })
    {
        return Err(ui_code("MONITOR_INVALID_DISTRO").into());
    }

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;

        if !wsl {
            return LocalTask::spawn(move |stop| windows::sample(stop, send))
                .map(|task| (task, None))
                .map_err(start_failed);
        }
        let mut command = Command::new("wsl.exe");
        if let Some(distro) = distro {
            command.args(["-d", distro]);
        }
        command.creation_flags(0x0800_0000).args(["-e", "sh"]);
        command
    };
    #[cfg(unix)]
    let mut command = {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new("/bin/sh");
        // The shell's utilities also inherit the stdout pipe. Stop the whole group.
        command.process_group(0);
        crate::child_env::strip_inherited(&mut command);
        command
    };

    let mut child = MonitorChild(
        command
            .args(["-c", SCRIPT])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(start_failed)?,
    );
    let pid = child.0.id();
    let stdout = child.0.stdout.take().expect("piped monitor stdout");
    let task = LocalTask::spawn(move |stop| {
        read_samples(stdout, stop, send);
        drop(child);
    })
    .map_err(start_failed)?;
    Ok((task, Some(pid)))
}

struct MonitorChild(Child);

impl Drop for MonitorChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: the unreaped child is the leader of its own process group.
        unsafe {
            libc::kill(-(self.0.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn read_samples(
    mut stdout: ChildStdout,
    stop: mpsc::Receiver<()>,
    mut send: impl FnMut(MonitorSample) -> bool + Send + 'static,
) {
    let mut parser = MonitorParser::default();
    let mut buffer = [0; 8192];
    while matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
        let available = match pipe_available(&stdout, buffer.len()) {
            Ok(0) => {
                if !matches!(
                    stop.recv_timeout(Duration::from_millis(50)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    break;
                }
                continue;
            }
            Ok(available) => available,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let size = match stdout.read(&mut buffer[..available]) {
            Ok(0) => break,
            Ok(size) => size,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if !parser.feed(&buffer[..size]).into_iter().all(&mut send) || parser.is_unsupported() {
            break;
        }
    }
}

#[cfg(unix)]
fn pipe_available(stdout: &ChildStdout, capacity: usize) -> io::Result<usize> {
    use std::os::fd::AsRawFd;

    let mut fd = libc::pollfd {
        fd: stdout.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: fd describes one live descriptor. Read on readiness or hangup to observe EOF.
    match unsafe { libc::poll(&mut fd, 1, 0) } {
        -1 => Err(io::Error::last_os_error()),
        0 => Ok(0),
        _ => Ok(capacity),
    }
}

#[cfg(windows)]
fn pipe_available(stdout: &ChildStdout, capacity: usize) -> io::Result<usize> {
    use std::{os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    let mut available = 0;
    // SAFETY: stdout owns the pipe handle, and available is a writable DWORD.
    let ok = unsafe {
        PeekNamedPipe(
            stdout.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(capacity.min(available as usize))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn local_shell_samples_memory_and_is_reaped() {
        let (send, receive) = mpsc::channel();
        let (task, pid) =
            start_source(false, None, move |sample| send.send(sample).is_ok()).unwrap();
        let mut tasks = HashMap::from([(1, task)]);
        let sample = receive.recv_timeout(Duration::from_secs(10));
        LocalMonitors::stop(&mut tasks, 1).unwrap();
        let sample = sample.unwrap();
        assert!(sample.mem_total > 0);
        assert_eq!(sample.mem_total % 1024, 0);
        // SAFETY: signal zero only checks whether the child PID still exists.
        assert_eq!(unsafe { libc::kill(pid.unwrap() as libc::pid_t, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}
