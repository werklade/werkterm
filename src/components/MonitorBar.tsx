import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";
import { MonitorTooltip as Tip } from "./MonitorTooltip";
import { decimal, rate, size, uptime, users, distro, distroBadges, history, dfTable, orderDisks, fittingCount, type Disk } from "./monitorFormat";
import { currentLocale, useT } from "../i18n";
import "./MonitorBar.css";
interface Network { name: string; rx: number; tx: number; rxErrors: number; txErrors: number; rxDrop: number; txDrop: number }
interface Sample { host: string; version: string | null; osName: string | null; osId: string | null; osIdLike: string | null; cpuCores: number | null; load: number[]; cpuParts: number[]; cpuPercent: number | null; memUsed: number; memTotal: number; memAvailable: number | null; cached: number | null; buffers: number | null; swapTotal: number | null; swapUsed: number | null; netRx: number | null; netTx: number | null; interfaces: Network[]; uptimeSecs: number; who: string[]; disks: Disk[]; dfAll: Disk[]; unsupported: boolean }
function Meter({ value }: { value: number }) { return <meter min={0} max={100} value={value} className={value >= 90 ? "critical" : value >= 75 ? "warn" : "ok"} />; }
function Table({ rows }: { rows: [string, string][] }) { return <table><tbody>{rows.map(([name, value]) => <tr key={name}><td>{name}</td><td>{value}</td></tr>)}</tbody></table>; }
let monitorQueue: Promise<unknown> = Promise.resolve();
export function MonitorBar({ sessionId }: { sessionId: number }) {
  const t = useT();
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
  if (error) return <div className="monitor-bar"><Tip content={error}>{t("monitor.unavailable")}</Tip></div>;
  if (!sample) return <div className="monitor-bar">{t("monitor.loading")}</div>;
  if (sample.unsupported) return <div className="monitor-bar">{t("monitor.noLinux")}</div>;
  const cpu = <><strong>{t("monitor.cpuNow", { value: sample.cpuPercent === null ? "–" : decimal(sample.cpuPercent) })}</strong><Table rows={([ ["monitor.cpu.user", 0], ["monitor.cpu.system", 2], ["monitor.cpu.iowait", 4], ["monitor.cpu.steal", 7]] as const).map(([label, i]) => [t(label), sample.cpuParts[i] === undefined ? "–" : `${decimal(sample.cpuParts[i] + (i === 0 ? sample.cpuParts[1] ?? 0 : 0), 1)} %`])} /><div>{t("monitor.load", { values: sample.load.map(v => decimal(v, 2)).join(" / ") || "–" })}</div></>;
  const network = (upload: boolean) => <Table rows={sample.interfaces.flatMap(n => [[t(upload ? "monitor.net.sent" : "monitor.net.received", { name: n.name }), size(upload ? n.tx : n.rx)], [t("monitor.net.errors", { name: n.name }), decimal(upload ? n.txErrors : n.rxErrors)], [t("monitor.net.dropped", { name: n.name }), decimal(upload ? n.txDrop : n.rxDrop)]] as [string, string][])} />;
  const df = <><strong>{t("monitor.dfOutput")}</strong><pre>{dfTable(sample.dfAll)}</pre></>;
  const dist = distro(sample.osId, sample.osIdLike);
  const distIcon = dist === "debian" ? <span className="monitor-tux" role="img" aria-label="Debian"><Icon name="debian" /></span> : dist === "tux" ? <span className="monitor-tux" role="img" aria-label="Linux"><Icon name="tux" /></span> : <span className="monitor-distro" style={{ background: distroBadges[dist][1] }} aria-hidden="true">{distroBadges[dist][0]}</span>;
  const visible = disks.slice(0, shown), hidden = disks.slice(visible.length);
  return <div className="monitor-bar" ref={bar}>
    <Tip content={<><div>{t("monitor.host.hostname", { value: sample.host || "–" })}</div><div>{t("monitor.host.system", { value: sample.osName ?? "–" })}</div><div>{t("monitor.host.version", { value: sample.version ?? "–" })}</div><div>{t("monitor.host.cores", { value: sample.cpuCores ?? "–" })}</div></>}>{distIcon}{sample.host || "–"}</Tip>
    <Tip content={cpu}>CPU {sample.cpuPercent === null ? "–" : `${decimal(sample.cpuPercent)} %`}</Tip>
    <Tip content={cpu}><svg className="monitor-history" viewBox="0 0 60 16" role="img" aria-label={t("monitor.cpuHistory")}>{values.map((v, i) => <rect key={i} x={60 - values.length + i} y={16 - v * .16} width=".8" height={v * .16} />)}</svg></Tip>
    <Tip content={<Table rows={([ ["monitor.mem.total", sample.memTotal], ["monitor.mem.used", sample.memUsed], ["monitor.mem.available", sample.memAvailable], ["monitor.mem.cache", sample.cached], ["monitor.mem.buffers", sample.buffers], ["monitor.mem.swapTotal", sample.swapTotal], ["monitor.mem.swapUsed", sample.swapUsed]] as const).map(([n, v]) => [t(n), v === null ? "–" : `${decimal(v / 1024 ** 2, 2)} MiB`])} />}>RAM {decimal(sample.memUsed / 1024 ** 3, 2)} / {decimal(sample.memTotal / 1024 ** 3, 2)} GiB <Meter value={sample.memTotal ? sample.memUsed / sample.memTotal * 100 : 0} /></Tip>
    <Tip content={network(true)}>↑ {rate(sample.netTx)}</Tip><Tip content={network(false)}>↓ {rate(sample.netRx)}</Tip>
    <Tip content={<><div>{t("monitor.uptime", { value: uptime(sample.uptimeSecs, true) })}</div><div>{t("monitor.started", { value: new Date(Date.now() - sample.uptimeSecs * 1000).toLocaleString(currentLocale()) })}</div></>}>◷ {uptime(sample.uptimeSecs)}</Tip>
    <Tip content={<><strong>{t("monitor.whoOutput")}</strong><pre>{sample.who.join("\n") || "–"}</pre></>}>♙ {users(sample.who)}</Tip>
    <div className="monitor-disks" ref={diskBox}>
      {visible.map(d => <span key={d.device + d.mount} data-mount={d.mount} className="monitor-disk"><Tip content={df}><span className={d.usedPercent >= 90 ? "monitor-critical" : undefined}>{d.mount}: {decimal(d.usedPercent)} %</span> <Meter value={d.usedPercent} /></Tip></span>)}
      {hidden.length > 0 && <Tip content={<><strong>{t("monitor.moreDisks")}</strong><Table rows={hidden.map(d => [d.mount, t("monitor.diskUsage", { percent: decimal(d.usedPercent), size: size(d.sizeBytes) })] as [string, string])} /></>}>+{hidden.length}</Tip>}
    </div>
  </div>;
}
