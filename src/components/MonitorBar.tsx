import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
interface Disk { mount: string; usedPercent: number; sizeBytes: number }
interface Sample { host: string; cpuPercent: number | null; memUsed: number; memTotal: number; netRx: number | null; netTx: number | null; uptimeSecs: number; users: number | null; disks: Disk[]; unsupported: boolean }
const gb = (n: number) => (n / 1e9).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const rate = (n: number | null) => n === null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB/s` : `${(n / 1000).toFixed(1)} kB/s`;
function Meter({ value }: { value: number }) { return <meter min={0} max={100} value={value} className={value >= 90 ? "critical" : ""} />; }
let monitorQueue: Promise<unknown> = Promise.resolve();
export function MonitorBar({ sessionId }: { sessionId: number }) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setSample(null); setError("");
    const channel = new Channel<Sample>();
    channel.onmessage = value => { if (alive) setSample(value); };
    monitorQueue = monitorQueue.catch(() => undefined).then(async () => {
      if (alive) await invoke("ssh_monitor_start", { id: sessionId, onSample: channel });
    }).catch((reason: unknown) => { if (alive) setError(String(reason)); });
    return () => {
      alive = false;
      monitorQueue = monitorQueue.catch(() => undefined).then(() => invoke("ssh_monitor_stop", { id: sessionId }));
    };
  }, [sessionId]);
  if (error) return <div className="monitor-bar" title={error}>Monitoring nicht verfügbar</div>;
  if (!sample) return <div className="monitor-bar">Monitoring wird geladen…</div>;
  if (sample.unsupported) return <div className="monitor-bar">Monitoring nicht verfügbar (kein Linux)</div>;
  return <div className="monitor-bar">
    <span>▣ {sample.host}</span><span>CPU {sample.cpuPercent === null ? "–" : `${sample.cpuPercent.toFixed(0)} %`}{sample.cpuPercent !== null && <Meter value={sample.cpuPercent} />}</span>
    <span>RAM {gb(sample.memUsed)} / {gb(sample.memTotal)} GB <Meter value={sample.memTotal ? sample.memUsed / sample.memTotal * 100 : 0} /></span>
    <span>↓ {rate(sample.netRx)} ↑ {rate(sample.netTx)}</span>
    <span>◷ {Math.floor(sample.uptimeSecs / 86400)} T {Math.floor(sample.uptimeSecs / 3600) % 24} h</span><span>♙ {sample.users ?? "–"}</span>
    <span title={sample.disks.map(d => `${d.mount}: ${d.usedPercent}% (${gb(d.sizeBytes)} GB)`).join("\n")}>{sample.disks.slice(0, 3).map(d => <span key={d.mount}>{d.mount} {d.usedPercent}% <Meter value={d.usedPercent} /></span>)}{sample.disks.length > 3 && ` +${sample.disks.length - 3}`}</span>
  </div>;
}
