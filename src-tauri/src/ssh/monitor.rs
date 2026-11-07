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
printf 'USERS\n'; if logged=$(who 2>/dev/null); then
if [ -n "$logged" ]; then printf '%s\n' "$logged" | wc -l; else printf '0\n'; fi
else printf '\n'; fi
printf 'DISKS\n'; df -P -k 2>/dev/null | awk 'NR==FNR { if ($3 ~ /^(tmpfs|devtmpfs|overlay|squashfs)$/) skip[$2]=1; next } FNR==1 || !skip[$6]' /proc/mounts -
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
    unsupported: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Disk {
    mount: String,
    used_percent: u32,
    size_bytes: u64,
}
#[derive(Debug)]
struct Snapshot {
    sample: MonitorSample,
    cpu: Vec<u64>,
    rx: u64,
    tx: u64,
    uptime: f64,
}
fn section<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    text.split_once(start)?.1.split_once(end).map(|v| v.0)
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
    let memory = section(text, "\nMEM\n", "\nNET\n")?;
    let mem = |key: &str| -> Option<u64> {
        memory.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name == key)
                .then(|| {
                    value
                        .split_whitespace()
                        .next()?
                        .parse::<u64>()
                        .ok()?
                        .checked_mul(1024)
                })
                .flatten()
        })
    };
    let total = mem("MemTotal")?;
    let available = mem("MemAvailable").or_else(|| {
        mem("MemFree")?
            .checked_add(mem("Buffers")?)?
            .checked_add(mem("Cached")?)
    })?;
    if available > total {
        return None;
    }
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in section(text, "\nNET\n", "\nUP\n")?.lines() {
        let Some((name, values)) = line.split_once(':') else {
            continue;
        };
        if name.trim() == "lo" {
            continue;
        }
        let values = values
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<Vec<u64>, _>>()
            .ok()?;
        if values.len() < 16 {
            return None;
        }
        rx = rx.checked_add(values[0])?;
        tx = tx.checked_add(values[8])?;
    }
    let uptime: f64 = section(text, "\nUP\n", "\nUSERS\n")?.trim().parse().ok()?;
    if !uptime.is_finite() || uptime < 0.0 {
        return None;
    }
    let users = section(text, "\nUSERS\n", "\nDISKS\n")?.trim().parse().ok();
    let mut disks = Vec::new();
    for line in section(text, "\nDISKS\n", "\nHOST\n")?.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 6 {
            return None;
        }
        let used_percent = fields[4].strip_suffix('%')?.parse::<u32>().ok()?;
        let size_bytes = fields[1].parse::<u64>().ok()?.checked_mul(1024)?;
        disks.push(Disk {
            mount: fields[5..].join(" "),
            used_percent,
            size_bytes,
        });
    }
    let host = text.split_once("\nHOST\n")?.1.trim().to_owned();
    if host.is_empty() {
        return None;
    }
    Some(Snapshot {
        sample: MonitorSample {
            host,
            mem_used: total - available,
            mem_total: total,
            uptime_secs: uptime as u64,
            users,
            disks,
            ..Default::default()
        },
        cpu,
        rx,
        tx,
        uptime,
    })
}
fn deltas(current: &mut Snapshot, previous: &Snapshot) {
    let elapsed = current.uptime - previous.uptime;
    if elapsed <= 0.0 {
        return;
    }
    current.sample.net_rx = current
        .rx
        .checked_sub(previous.rx)
        .map(|v| (v as f64 / elapsed) as u64);
    current.sample.net_tx = current
        .tx
        .checked_sub(previous.tx)
        .map(|v| (v as f64 / elapsed) as u64);
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
        return Err("SSH-Sitzung beendet".into());
    }
    let mut channel = tokio::time::timeout(PHASE_TIMEOUT, session.handle.channel_open_session())
        .await
        .map_err(|_| "Monitoring: Zeitüberschreitung")?
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
        return Err("Monitoring-Kanal abgelehnt".into());
    }
    if session.monitor_closed.load(Ordering::Acquire) {
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
        return Err("SSH-Sitzung beendet".into());
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
            "cpu {cpu}\nMEM\nMemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\nNET\neth0: {rx} 0 0 0 0 0 0 0 {rx} 0 0 0 0 0 0 0\nlo: 9999 0 0 0 0 0 0 0 9999 0 0 0 0 0 0 0\nUP\n{uptime}\nUSERS\n2\nDISKS\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 100 50 50 50% /\nHOST\nserver"
        )
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
        let sample = parse(&text.replace("\n2\nDISKS", "\n\nDISKS"))
            .unwrap()
            .sample;
        assert_eq!(sample.mem_used, 500 * 1024);
        assert!(sample.users.is_none());
        for text in [
            "".to_owned(),
            "cpu nope".to_owned(),
            text.replace("1000 kB", "1 kB"),
            text.replace("50%", "bad"),
            text.replace("\n10\nUSERS", "\nNaN\nUSERS"),
        ] {
            assert!(parse(&text).is_none());
        }
        let mut parser = MonitorParser::default();
        assert!(parser.feed(&vec![b'x'; 1_048_577]).is_empty());
        assert!(parser.buffer.is_empty());
    }
}
