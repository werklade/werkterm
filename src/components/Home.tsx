import { useState } from "react";
import appIcon from "../assets/app-icon.svg";
import { KindIcon } from "./KindIcon";
import { searchSessions, type Recent } from "../lib/history";
import { parseQuickConnect } from "../lib/quickConnect";
import { jumpHostHint, type SavedSession } from "../lib/sessions";
export function Home({ sessions, recents, canRestore, onLocal, onRestore, onSaved, onQuick }: {
  sessions: SavedSession[]; recents: Recent[]; canRestore: boolean; onLocal(): void; onRestore(): void;
  onSaved(session: SavedSession): void; onQuick(target: string): void;
}) {
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState(0);
  const results = searchSessions(sessions, query);
  const quick = parseQuickConnect(query) !== null;
  const count = results.length + Number(quick);
  const choose = (index: number) => { if (results[index]) onSaved(results[index]); else if (quick) onQuick(query.trim()); };
  const visible = recents.filter(r => r.kind === "quick" || sessions.some(s => s.id === r.sessionId)).slice(0, 9);
  return <section className="home" role="tabpanel" id="home-panel" aria-labelledby="tab-home">
    <div className="home-content"><img src={appIcon} alt="" width="86" height="86"/><h1>Werkterm</h1>
    <div className="home-actions"><button onClick={onLocal}>Lokales Terminal starten</button><button disabled={!canRestore} onClick={onRestore}>Vorherige Sitzungen wiederherstellen</button></div>
    <input className="home-search" aria-label="Sitzung oder Server suchen" placeholder="Sitzung oder Server suchen…" value={query} role="combobox" aria-expanded={count > 0} aria-controls="home-results" aria-activedescendant={count ? `home-result-${Math.min(selected, count - 1)}` : undefined} onChange={e => { setQuery(e.target.value); setSelected(0); }} onKeyDown={e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (count) setSelected(i => (i + (e.key === "ArrowDown" ? 1 : count - 1)) % count); }
      if (e.key === "Enter" && count) { e.preventDefault(); choose(Math.min(selected, count - 1)); }
      if (e.key === "Escape") setQuery("");
    }}/>
    {count > 0 && <div id="home-results" role="listbox" className="home-results">{results.map((s, i) => <button role="option" aria-selected={i === selected} title={jumpHostHint(s, sessions) || undefined} id={`home-result-${i}`} key={s.id} onClick={() => onSaved(s)}><KindIcon kind={s.kind}/>{s.name} · {s.user}@{s.host}</button>)}{quick && <button role="option" aria-selected={selected === results.length} id={`home-result-${results.length}`} onClick={() => onQuick(query.trim())}>Quick connect: {query.trim()}</button>}</div>}
    <h2>Zuletzt verwendet</h2>{visible.length ? <div className="recent-grid">{visible.map((r, i) => <button key={i} title={r.kind === "saved" ? (() => { const s = sessions.find(s => s.id === r.sessionId); return s ? jumpHostHint(s, sessions) || undefined : undefined; })() : undefined} onClick={() => { if (r.kind === "quick") onQuick(r.target); else { const s = sessions.find(s => s.id === r.sessionId); if (s) onSaved(s); } }}><KindIcon kind={r.kind === "saved" ? sessions.find(s => s.id === r.sessionId)?.kind ?? "ssh" : "ssh"}/>{r.kind === "quick" ? r.target : sessions.find(s => s.id === r.sessionId)?.name}</button>)}</div> : <p>Noch keine Verbindungen verwendet.</p>}
    <p className="home-hint">Help → Tastenkürzel zeigt die verfügbaren Tastenkombinationen.</p></div>
  </section>;
}
