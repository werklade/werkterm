use super::*;
use tauri::{State, ipc::Channel};

const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
if [ ! -r /proc/stat ]; then printf 'UNSUPPORTED\n'; exit; fi
while :; do
printf 'WERKTERM_BEGIN\n'
head -n 1 /proc/stat
printf 'MEM\n'; cat /proc/meminfo
printf 'NET\n'; cat /proc/net/dev
printf 'UP\n'; cut -d ' ' -f 1 /proc/uptime
printf 'USERS\n'; who 2>/dev/null || :
printf 'DISKS\n'; df -P -k 2>/dev/null | awk 'NR==FNR { if ($3 ~ /^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|ramfs|proc|sysfs|cgroup2?|devpts|securityfs|pstore|bpf|tracefs|debugfs|configfs|fusectl|hugetlbfs|mqueue|binfmt_misc|nsfs|autofs|fuse\.lxcfs|fuse\.gvfsd-fuse|fuse\.portal)$/ && $2 != "/tmp") skip[$2]=1; next } FNR==1 || !skip[$6]' /proc/mounts -
printf 'DFALL\n'; df -P -k 2>/dev/null
printf 'VERSION\n'; cat /proc/version
printf 'OS\n'; if [ -r /etc/os-release ]; then cat /etc/os-release; fi
printf 'CPUS\n'; grep -c '^processor' /proc/cpuinfo
printf 'LOAD\n'; cat /proc/loadavg
printf 'HOST\n'; uname -n
printf 'WERKTERM_END\n'
sleep 2
done"#;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSample {
    host: String,
    cpu_percent: Option<f32>,
    mem_used: u64,
    mem_total: u64,
    net_rx: Option<u64>,
    net_tx: Option<u64>,
    uptime_secs: u64,
    users: Option<u32>,
    disks: Vec<Disk>,
    version: Option<String>,
    os_name: Option<String>,
    os_id: Option<String>,
    os_id_like: Option<String>,
    cpu_cores: Option<u32>,
    load: Vec<f64>,
    cpu_parts: Vec<f32>,
    mem_available: Option<u64>,
    cached: Option<u64>,
    buffers: Option<u64>,
    swap_total: Option<u64>,
    swap_used: Option<u64>,
    interfaces: Vec<Network>,
    who: Vec<String>,
    df_all: Vec<Disk>,
    unsupported: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Disk {
    device: String,
    used_bytes: u64,
    free_bytes: u64,
    mount: String,
    used_percent: u32,
    size_bytes: u64,
}
#[derive(Debug)]
struct Snapshot {
    sample: MonitorSample,
    cpu: Vec<u64>,
    uptime: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Network {
    name: String,
    rx: u64,
    tx: u64,
    rx_errors: u64,
    tx_errors: u64,
    rx_drop: u64,
    tx_drop: u64,
    rx_rate: Option<u64>,
    tx_rate: Option<u64>,
}
fn section<'a>(text: &'a str, name: &str) -> &'a str {
    const MARKERS: [&str; 12] = [
        "MEM",
        "NET",
        "UP",
        "USERS",
        "DISKS",
        "DFALL",
        "HOST",
        "VERSION",
        "OS",
        "CPUS",
        "LOAD",
        "WERKTERM_END",
    ];
    let Some((_, rest)) = text.split_once(&format!("\n{name}\n")) else {
        return "";
    };
    let end = rest
        .split_inclusive('\n')
        .scan(0, |offset, line| {
            let start = *offset;
            *offset += line.len();
            Some((start, line.trim_end()))
        })
        .find(|(_, line)| MARKERS.contains(line))
        .map_or(rest.len(), |(offset, _)| offset);
    rest[..end].trim_end()
}
fn disks(text: &str) -> Vec<Disk> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<_> = line.split_whitespace().collect();
            if f.len() < 6 {
                return None;
            }
            let bytes = |i: usize| f[i].parse::<u64>().ok()?.checked_mul(1024);
            Some(Disk {
                device: f[0].into(),
                size_bytes: bytes(1)?,
                used_bytes: bytes(2)?,
                free_bytes: bytes(3)?,
                used_percent: f[4].strip_suffix('%')?.parse().ok()?,
                mount: f[5..].join(" "),
            })
        })
        .collect()
}
fn parse(text: &str) -> Option<Snapshot> {
    let cpu = text
        .lines()
        .next()?
        .strip_prefix("cpu ")?
        .split_whitespace()
        .take(8)
        .map(str::parse)
        .collect::<Result<Vec<u64>, _>>()
        .ok()?;
    if cpu.len() < 4 {
        return None;
    }
    let memory = section(text, "MEM");
    let mem = |key: &str| {
        memory.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name != key {
                return None;
            }
            value
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()?
                .checked_mul(1024)
        })
    };
    let total = mem("MemTotal").unwrap_or(0);
    let available = mem("MemAvailable").or_else(|| {
        mem("MemFree")?
            .checked_add(mem("Buffers").unwrap_or(0))?
            .checked_add(mem("Cached").unwrap_or(0))
    });
    if available.is_some_and(|v| v > total) {
        return None;
    }
    let interfaces: Vec<_> = section(text, "NET")
        .lines()
        .filter_map(|line| {
            let (name, values) = line.split_once(':')?;
            if name.trim() == "lo" {
                return None;
            }
            let v = values
                .split_whitespace()
                .map(str::parse)
                .collect::<Result<Vec<u64>, _>>()
                .ok()?;
            if v.len() < 16 {
                return None;
            }
            Some(Network {
                name: name.trim().into(),
                rx: v[0],
                tx: v[8],
                rx_errors: v[2],
                tx_errors: v[10],
                rx_drop: v[3],
                tx_drop: v[11],
                rx_rate: None,
                tx_rate: None,
            })
        })
        .collect();
    let uptime = section(text, "UP").trim().parse::<f64>().unwrap_or(0.0);
    if !uptime.is_finite() || uptime < 0.0 {
        return None;
    }
    let os = |key: &str| {
        section(text, "OS").lines().find_map(|line| {
            let (k, v) = line.split_once('=')?;
            (k == key).then(|| v.trim_matches(['"', '\'']).to_owned())
        })
    };
    let who: Vec<_> = section(text, "USERS")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect();
    Some(Snapshot {
        sample: MonitorSample {
            host: section(text, "HOST").trim().into(),
            version: (!section(text, "VERSION").is_empty())
                .then(|| section(text, "VERSION").into()),
            os_name: os("PRETTY_NAME"),
            os_id: os("ID"),
            os_id_like: os("ID_LIKE"),
            cpu_cores: section(text, "CPUS").trim().parse().ok(),
            load: section(text, "LOAD")
                .split_whitespace()
                .take(3)
                .filter_map(|v| v.parse().ok().filter(|v: &f64| v.is_finite()))
                .collect(),
            mem_total: total,
            mem_used: total.saturating_sub(available.unwrap_or(total)),
            mem_available: available,
            cached: mem("Cached"),
            buffers: mem("Buffers"),
            swap_total: mem("SwapTotal"),
            swap_used: mem("SwapTotal")
                .zip(mem("SwapFree"))
                .map(|(t, f)| t.saturating_sub(f)),
            uptime_secs: uptime as u64,
            users: (!who.is_empty()).then_some(who.len() as u32),
            who,
            interfaces,
            disks: disks(section(text, "DISKS")),
            df_all: disks(section(text, "DFALL")),
            ..Default::default()
        },
        cpu,
        uptime,
    })
}
fn deltas(current: &mut Snapshot, previous: &Snapshot) {
    let elapsed = current.uptime - previous.uptime;
    if elapsed <= 0.0 {
        return;
    }
    for interface in &mut current.sample.interfaces {
        if let Some(old) = previous
            .sample
            .interfaces
            .iter()
            .find(|n| n.name == interface.name)
        {
            interface.rx_rate = interface
                .rx
                .checked_sub(old.rx)
                .map(|v| (v as f64 / elapsed) as u64);
            interface.tx_rate = interface
                .tx
                .checked_sub(old.tx)
                .map(|v| (v as f64 / elapsed) as u64);
        }
    }
    current.sample.net_rx = current
        .sample
        .interfaces
        .iter()
        .try_fold(0u64, |sum, n| sum.checked_add(n.rx_rate?));
    current.sample.net_tx = current
        .sample
        .interfaces
        .iter()
        .try_fold(0u64, |sum, n| sum.checked_add(n.tx_rate?));
    if current.cpu.len() != previous.cpu.len() {
        return;
    }
    let differences: Option<Vec<u64>> = current
        .cpu
        .iter()
        .zip(&previous.cpu)
        .map(|(a, b)| a.checked_sub(*b))
        .collect();
    if let Some(values) = differences {
        let total: Option<u64> = values.iter().try_fold(0u64, |sum, v| sum.checked_add(*v));
        let idle = values[3].checked_add(values.get(4).copied().unwrap_or(0));
        if let (Some(total), Some(idle)) = (total, idle)
            && total > 0
            && idle <= total
        {
            current.sample.cpu_parts = values
                .iter()
                .map(|v| (100.0 * *v as f64 / total as f64) as f32)
                .collect();
            current.sample.cpu_percent =
                Some((100.0 * (total - idle) as f64 / total as f64) as f32);
        }
    }
}
// Incremental framing is independent of SSH and accepts arbitrary packet boundaries.
#[derive(Default)]
struct MonitorParser {
    buffer: Vec<u8>,
    block: String,
    collecting: bool,
    previous: Option<Snapshot>,
    unsupported: bool,
}
impl MonitorParser {
    fn feed(&mut self, data: &[u8]) -> Vec<MonitorSample> {
        let mut samples = Vec::new();
        if self.unsupported {
            return samples;
        }
        self.buffer.extend_from_slice(data);
        if self.buffer.len() > 1_048_576 {
            self.buffer.clear();
            self.block.clear();
            self.collecting = false;
            return samples;
        }
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let bytes: Vec<_> = self.buffer.drain(..=end).collect();
            let Ok(line) = std::str::from_utf8(&bytes) else {
                self.collecting = false;
                continue;
            };
            match line.trim_end_matches(['\r', '\n']) {
                "UNSUPPORTED" => {
                    self.unsupported = true;
                    samples.push(MonitorSample {
                        unsupported: true,
                        ..Default::default()
                    });
                    break;
                }
                "WERKTERM_BEGIN" => {
                    self.block.clear();
                    self.collecting = true;
                }
                "WERKTERM_END" => {
                    if self.collecting
                        && let Some(mut next) = parse(self.block.trim_end())
                    {
                        if let Some(old) = &self.previous {
                            deltas(&mut next, old);
                        }
                        samples.push(next.sample.clone());
                        self.previous = Some(next);
                    }
                    self.collecting = false;
                }
                line if self.collecting => {
                    self.block.push_str(line);
                    self.block.push('\n');
                    if self.block.len() > 1_048_576 {
                        self.collecting = false;
                        self.block.clear();
                    }
                }
                _ => {}
            }
        }
        samples
    }
}
pub(super) struct MonitorTask {
    stop: oneshot::Sender<()>,
    done: tokio::task::JoinHandle<()>,
}
pub(super) async fn stop_session(session: &Session) {
    let mut guard = session.monitor.lock().await;
    if let Some(task) = guard.take() {
        let _ = task.stop.send(());
        let _ = task.done.await;
    }
}
#[tauri::command]
pub async fn ssh_monitor_stop(state: State<'_, Arc<SshManager>>, id: u32) -> Result<(), String> {
    if let Ok(session) = state.session(id).await {
        stop_session(&session).await;
    }
    Ok(())
}
#[tauri::command]
pub async fn ssh_monitor_start(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    on_sample: Channel<MonitorSample>,
) -> Result<(), String> {
    let session = state.session(id).await?;
    let mut guard = session.monitor.lock().await;
    if let Some(task) = guard.take() {
        let _ = task.stop.send(());
        let _ = task.done.await;
    }
    if session.monitor_closed.load(Ordering::Acquire) {
        return Err(crate::ui_error::ui_err("SSH_SESSION_ENDED").into());
    }
    let mut channel = tokio::time::timeout(PHASE_TIMEOUT, session.handle.channel_open_session())
        .await
        .map_err(|_| crate::ui_error::ui_code("MONITOR_TIMEOUT"))?
        .map_err(ssh_error)?;
    let setup = tokio::time::timeout(PHASE_TIMEOUT, async {
        channel
            .exec(true, format!("sh -c {}", quote(SCRIPT)))
            .await
            .map_err(ssh_error)?;
        reply(&mut channel).await
    })
    .await;
    if !matches!(setup, Ok(Ok(()))) {
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
        return Err(crate::ui_error::ui_err("MONITOR_REJECTED").into());
    }
    if session.monitor_closed.load(Ordering::Acquire) {
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
        return Err(crate::ui_error::ui_err("SSH_SESSION_ENDED").into());
    }
    let (stop, mut stopped) = oneshot::channel();
    let done = tokio::spawn(async move {
        let mut parser = MonitorParser::default();
        'read: loop {
            tokio::select! {
                _ = &mut stopped => break,
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) => {
                        for sample in parser.feed(&data) {
                            if on_sample.send(sample).is_err() { break 'read; }
                        }
                        if parser.unsupported { break; }
                    }
                    Some(ChannelMsg::Close | ChannelMsg::Eof | ChannelMsg::Failure) | None => break,
                    _ => {}
                }
            }
        }
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.eof()).await;
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
    });
    *guard = Some(MonitorTask { stop, done });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn block(cpu: &str, rx: u64, uptime: u32) -> String {
        format!(
            "cpu {cpu}\nMEM\nMemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\nNET\neth0: {rx} 0 0 0 0 0 0 0 {rx} 0 0 0 0 0 0 0\nlo: 9999 0 0 0 0 0 0 0 9999 0 0 0 0 0 0 0\nUP\n{uptime}\nUSERS\nalice pts/0\nbob pts/1\nDISKS\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 100 50 50 50% /\nHOST\nserver"
        )
    }
    #[test]
    fn extended_sections_and_interface_rates() {
        let extra = "\nVERSION\nLinux version example\nOS\nPRETTY_NAME=\"Debian GNU/Linux\"\nID=debian\nCPUS\n4\nLOAD\n0.10 0.20 0.30 1/100 42\nDFALL\nFilesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 100 10 90 10% /run";
        let first = parse(&(block("10 10 10 10 10 10 10 10", 100, 10) + extra)).unwrap();
        let mut next = parse(&(block("20 20 20 20 20 20 20 20", 300, 12) + extra)).unwrap();
        deltas(&mut next, &first);
        assert_eq!(next.sample.cpu_parts, vec![12.5; 8]);
        assert_eq!(next.sample.cpu_percent, Some(75.0));
        assert_eq!(next.sample.interfaces[0].rx_rate, Some(100));
        assert_eq!(next.sample.interfaces[0].tx_rate, Some(100));
        assert_eq!(next.sample.cpu_cores, Some(4));
        assert_eq!(next.sample.os_id.as_deref(), Some("debian"));
        assert!(next.sample.os_id_like.is_none());
        assert_eq!(next.sample.os_name.as_deref(), Some("Debian GNU/Linux"));
        assert_eq!(
            next.sample.version.as_deref(),
            Some("Linux version example")
        );
        assert_eq!(next.sample.load, vec![0.1, 0.2, 0.3]);
        assert_eq!(next.sample.df_all[0].device, "tmpfs");
        assert_eq!(next.sample.who.len(), 2);
        let minimal = parse("cpu 1 2 3 4").unwrap().sample;
        assert!(minimal.os_id.is_none());
        assert!(minimal.who.is_empty());
        assert!(minimal.interfaces.is_empty());
        // BusyBox installations may not provide who or os-release.
        let busybox = parse(&block("1 2 3 4", 1, 1).replace("alice pts/0\nbob pts/1", ""))
            .unwrap()
            .sample;
        assert!(busybox.who.is_empty());
        assert!(busybox.os_name.is_none());
        assert!(busybox.users.is_none());
        let swap = parse(
            &block("1 2 3 4", 1, 1).replace("MEM\n", "MEM\nSwapTotal: 100 kB\nSwapFree: 25 kB\n"),
        )
        .unwrap()
        .sample;
        assert_eq!(swap.swap_used, Some(75 * 1024));
        assert_eq!(swap.cached, Some(150 * 1024));
        let errors = parse(&block("1 2 3 4", 1, 1).replace(
            "eth0: 1 0 0 0 0 0 0 0 1 0 0 0",
            "eth0: 1 0 2 3 0 0 0 0 1 0 4 5",
        ))
        .unwrap()
        .sample;
        assert_eq!(errors.interfaces[0].rx_errors, 2);
        assert_eq!(errors.interfaces[0].tx_drop, 5);
    }
    #[test]
    fn parser_and_deltas() {
        let first = parse(&block("10 0 0 90", 100, 10)).unwrap();
        assert_eq!(first.sample.mem_used, 700 * 1024);
        assert!(first.sample.cpu_percent.is_none());
        assert!(first.sample.net_rx.is_none());
        let mut next = parse(&block("20 0 0 100", 300, 12)).unwrap();
        deltas(&mut next, &first);
        assert_eq!(next.sample.cpu_percent, Some(50.0));
        assert_eq!(next.sample.net_rx, Some(100));
        assert_eq!(next.sample.disks[0].size_bytes, 102400);
        let mut reset = parse(&block("1 0 0 1", 1, 14)).unwrap();
        deltas(&mut reset, &next);
        assert!(reset.sample.cpu_percent.is_none());
        assert!(reset.sample.net_rx.is_none());
        let mut reboot = parse(&block("1 0 0 1", 1, 1)).unwrap();
        deltas(&mut reboot, &first);
        assert!(reboot.sample.net_tx.is_none());
    }
    #[test]
    fn fragmented_blocks_recover_after_invalid_data_and_emit_unsupported_once() {
        let mut parser = MonitorParser::default();
        let valid = format!(
            "WERKTERM_BEGIN\n{}\nWERKTERM_END\n",
            block("10 0 0 90", 100, 10)
        );
        let mut samples = Vec::new();
        for byte in valid.as_bytes() {
            samples.extend(parser.feed(&[*byte]));
        }
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].host, "server");
        assert!(
            parser
                .feed(b"WERKTERM_BEGIN\ncpu broken\nWERKTERM_END\n")
                .is_empty()
        );
        assert!(
            parser
                .feed(b"WERKTERM_BEGIN\n\xff\nWERKTERM_END\n")
                .is_empty()
        );
        assert_eq!(parser.feed(valid.as_bytes()).len(), 1);
        assert!(parser.feed(b"UNSUP").is_empty());
        let unsupported = parser.feed(b"PORTED\n");
        assert_eq!(unsupported.len(), 1);
        assert!(unsupported[0].unsupported);
        assert!(parser.feed(b"UNSUPPORTED\n").is_empty());
    }
    #[test]
    fn available_memory_optional_users_and_bad_blocks() {
        let text = block("10 0 0 90", 100, 10).replace("MemFree: 100 kB", "MemAvailable: 500 kB");
        let sample = parse(&text.replace("\nalice pts/0\nbob pts/1\nDISKS", "\n\nDISKS"))
            .unwrap()
            .sample;
        assert_eq!(sample.mem_used, 500 * 1024);
        assert!(sample.users.is_none());
        for text in [
            "".to_owned(),
            "cpu nope".to_owned(),
            text.replace("1000 kB", "1 kB"),
            text.replace("\n10\nUSERS", "\nNaN\nUSERS"),
        ] {
            assert!(parse(&text).is_none());
        }
        let mut parser = MonitorParser::default();
        assert!(parser.feed(&vec![b'x'; 1_048_577]).is_empty());
        assert!(parser.buffer.is_empty());
    }
}
