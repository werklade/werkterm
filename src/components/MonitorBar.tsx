import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";
import { MonitorTooltip as Tip } from "./MonitorTooltip";
import { decimal, rate, size, uptime, users, distro, distroBadges, history, dfTable, orderDisks, fittingCount, type Disk } from "./monitorFormat";
import "./MonitorBar.css";
interface Network { name: string; rx: number; tx: number; rxErrors: number; txErrors: number; rxDrop: number; txDrop: number }
interface Sample { host: string; version: string | null; osName: string | null; osId: string | null; osIdLike: string | null; cpuCores: number | null; load: number[]; cpuParts: number[]; cpuPercent: number | null; memUsed: number; memTotal: number; memAvailable: number | null; cached: number | null; buffers: number | null; swapTotal: number | null; swapUsed: number | null; netRx: number | null; netTx: number | null; interfaces: Network[]; uptimeSecs: number; who: string[]; disks: Disk[]; dfAll: Disk[]; unsupported: boolean }
function Meter({ value }: { value: number }) { return <meter min={0} max={100} value={value} className={value >= 90 ? "critical" : value >= 75 ? "warn" : "ok"} />; }
function Table({ rows }: { rows: [string, string][] }) { return <table><tbody>{rows.map(([name, value]) => <tr key={name}><td>{name}</td><td>{value}</td></tr>)}</tbody></table>; }
let monitorQueue: Promise<unknown> = Promise.resolve();
export function MonitorBar({ sessionId }: { sessionId: number }) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [values, setValues] = useState<number[]>([]);
  const [error, setError] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const diskBox = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [shown, setShown] = useState(Infinity);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [sample === null]);
  const disks = orderDisks(sample?.disks ?? []);
  const diskKey = disks.map(d => d.mount).join("|");
  // Measure rendered disk fields, then show as many as fit into the space left in the bar.
  useLayoutEffect(() => {
    const element = bar.current, box = diskBox.current;
    if (!element || !box) return;
    for (const child of Array.from(box.children) as HTMLElement[]) if (child.dataset.mount) widths.current.set(child.dataset.mount, child.offsetWidth + 12);
    // Space left for disks = bar width minus padding, the other fields and the gaps between them.
    const style = getComputedStyle(element);
    const gap = parseFloat(style.columnGap) || 0;
    const fields = Array.from(element.children) as HTMLElement[];
    const others = fields.filter(child => child !== box).reduce((sum, child) => sum + child.offsetWidth, 0) + gap * Math.max(0, fields.length - 1);
    const available = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - others - 4;
    const next = fittingCount(disks.map(d => widths.current.get(d.mount) ?? 150), available);
    if (next !== shown) setShown(next);
  });
  useEffect(() => { setShown(Infinity); }, [width, diskKey]);
  useEffect(() => {
    let alive = true;
    setSample(null); setError(""); setValues([]);
    const channel = new Channel<Sample>();
    channel.onmessage = value => { if (alive) { setSample(value); if (value.cpuPercent !== null) setValues(old => history(old, value.cpuPercent!)); } };
    monitorQueue = monitorQueue.catch(() => undefined).then(async () => {
      if (alive) await invoke("ssh_monitor_start", { id: sessionId, onSample: channel });
    }).catch((reason: unknown) => { if (alive) setError(String(reason)); });
    return () => {
      alive = false;
      monitorQueue = monitorQueue.catch(() => undefined).then(() => invoke("ssh_monitor_stop", { id: sessionId }));
    };
  }, [sessionId]);
  if (error) return <div className="monitor-bar"><Tip content={error}>Monitoring nicht verfügbar</Tip></div>;
  if (!sample) return <div className="monitor-bar">Monitoring wird geladen…</div>;
  if (sample.unsupported) return <div className="monitor-bar">Monitoring nicht verfügbar (kein Linux)</div>;
  const cpu = <><strong>Aktuelle CPU-Last: {sample.cpuPercent === null ? "–" : decimal(sample.cpuPercent)} %</strong><Table rows={([ ["Benutzer", 0], ["System", 2], ["I/O-Wait", 4], ["Steal", 7]] as const).map(([label, i]) => [label, sample.cpuParts[i] === undefined ? "–" : `${decimal(sample.cpuParts[i] + (i === 0 ? sample.cpuParts[1] ?? 0 : 0), 1)} %`])} /><div>Load (1/5/15 min): {sample.load.map(v => decimal(v, 2)).join(" / ") || "–"}</div></>;
  const network = (upload: boolean) => <Table rows={sample.interfaces.flatMap(n => [[`${n.name} ${upload ? "gesendet" : "empfangen"} gesamt`, size(upload ? n.tx : n.rx)], [`${n.name} Fehler`, decimal(upload ? n.txErrors : n.rxErrors)], [`${n.name} verworfen`, decimal(upload ? n.txDrop : n.rxDrop)]] as [string, string][])} />;
  const df = <><strong>Ausgabe von df:</strong><pre>{dfTable(sample.dfAll)}</pre></>;
  const dist = distro(sample.osId, sample.osIdLike);
  const distIcon = dist === "debian" ? <span className="monitor-tux" role="img" aria-label="Debian"><Icon name="debian" /></span> : dist === "tux" ? <span className="monitor-tux" role="img" aria-label="Linux"><Icon name="tux" /></span> : <span className="monitor-distro" style={{ background: distroBadges[dist][1] }} aria-hidden="true">{distroBadges[dist][0]}</span>;
  const visible = disks.slice(0, shown), hidden = disks.slice(visible.length);
  return <div className="monitor-bar" ref={bar}>
    <Tip content={<><div>Hostname: {sample.host || "–"}</div><div>System: {sample.osName ?? "–"}</div><div>Version: {sample.version ?? "–"}</div><div>CPU-Kerne: {sample.cpuCores ?? "–"}</div></>}>{distIcon}{sample.host || "–"}</Tip>
    <Tip content={cpu}>CPU {sample.cpuPercent === null ? "–" : `${decimal(sample.cpuPercent)} %`}</Tip>
    <Tip content={cpu}><svg className="monitor-history" viewBox="0 0 60 16" role="img" aria-label="CPU-Verlauf der letzten 60 Messwerte">{values.map((v, i) => <rect key={i} x={60 - values.length + i} y={16 - v * .16} width=".8" height={v * .16} />)}</svg></Tip>
    <Tip content={<Table rows={([ ["Gesamt", sample.memTotal], ["Belegt", sample.memUsed], ["Verfügbar", sample.memAvailable], ["Cache", sample.cached], ["Puffer", sample.buffers], ["Swap gesamt", sample.swapTotal], ["Swap belegt", sample.swapUsed]] as const).map(([n, v]) => [n, v === null ? "–" : `${decimal(v / 1024 ** 2, 2)} MiB`])} />}>RAM {decimal(sample.memUsed / 1024 ** 3, 2)} / {decimal(sample.memTotal / 1024 ** 3, 2)} GiB <Meter value={sample.memTotal ? sample.memUsed / sample.memTotal * 100 : 0} /></Tip>
    <Tip content={network(true)}>↑ {rate(sample.netTx)}</Tip><Tip content={network(false)}>↓ {rate(sample.netRx)}</Tip>
    <Tip content={<><div>Laufzeit: {uptime(sample.uptimeSecs, true)}</div><div>Gestartet: {new Date(Date.now() - sample.uptimeSecs * 1000).toLocaleString("de-DE")}</div></>}>◷ {uptime(sample.uptimeSecs)}</Tip>
    <Tip content={<><strong>Ausgabe von who:</strong><pre>{sample.who.join("\n") || "–"}</pre></>}>♙ {users(sample.who)}</Tip>
    <div className="monitor-disks" ref={diskBox}>
      {visible.map(d => <span key={d.device + d.mount} data-mount={d.mount} className="monitor-disk"><Tip content={df}><span className={d.usedPercent >= 90 ? "monitor-critical" : undefined}>{d.mount}: {decimal(d.usedPercent)} %</span> <Meter value={d.usedPercent} /></Tip></span>)}
      {hidden.length > 0 && <Tip content={<><strong>Weitere Laufwerke:</strong><Table rows={hidden.map(d => [d.mount, `${decimal(d.usedPercent)} % von ${size(d.sizeBytes)}`] as [string, string])} /></>}>+{hidden.length}</Tip>}
    </div>
  </div>;
}
