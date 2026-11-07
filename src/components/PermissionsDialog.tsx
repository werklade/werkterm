import { useState } from "react";
import type { DirEntry } from "../lib/fs";
import { chmodOptions, modeToRwx, octal, parseOctal, togglePermission, type ChmodOptions, type PermissionFields } from "../lib/permissions";
import { useModal } from "./useModal";

export function PermissionsDialog({ entry, onAnswer }: { entry: DirEntry; onAnswer: (options: ChmodOptions | null) => void }) {
  const dialog = useModal();
  const [fields, setFields] = useState<PermissionFields>({ value: octal(entry.permissions), recursive: false, split: false, directories: "755", files: "644" });
  const [lastMode, setLastMode] = useState(entry.permissions);
  const update = (change: Partial<PermissionFields>) => setFields(current => ({ ...current, ...change }));
  const mode = parseOctal(fields.value) ?? lastMode;
  const options = chmodOptions(fields);
  const setMode = (next: number) => { setLastMode(next); update({ value: octal(next) }); };
  const checkbox = (bit: number, label: string) => <input type="checkbox" aria-label={label} checked={(mode & bit) !== 0} onChange={event => setMode(togglePermission(mode, bit, event.target.checked))} />;
  return <dialog ref={dialog} className="ssh-dialog permissions-dialog" aria-modal="true" aria-labelledby="permissions-title" onCancel={event => { event.preventDefault(); onAnswer(null); }}>
    <form onSubmit={event => { event.preventDefault(); if (options) onAnswer(options); }}>
      <h2 id="permissions-title">Berechtigungen für {entry.name}</h2>
      <p>Besitzer: {entry.user ?? entry.uid ?? "unbekannt"} · Gruppe: {entry.group ?? entry.gid ?? "unbekannt"}</p>
      <p>Aktuelle Rechte: <code>{modeToRwx(entry.permissions)}</code></p>
      <table><thead><tr><th scope="col">Recht</th>{["Besitzer", "Gruppe", "Andere"].map(group => <th scope="col" key={group}>{group}</th>)}</tr></thead>
        <tbody>{[["Lesen", 4], ["Schreiben", 2], ["Ausführen", 1]].map(([label, bit]) => <tr key={label}><th scope="row">{label}</th>{["Besitzer", "Gruppe", "Andere"].map((group, index) => <td key={group}>{checkbox(Number(bit) << ((2 - index) * 3), `${group}: ${label}`)}</td>)}</tr>)}</tbody></table>
      <label>Oktal <input autoFocus value={fields.value} inputMode="numeric" maxLength={4} aria-invalid={parseOctal(fields.value) === null} onChange={event => { const value = event.target.value; update({ value }); const next = parseOctal(value); if (next !== null) setLastMode(next); }} /></label>
      <details><summary>Erweitert</summary>{[["setuid", 0o4000], ["setgid", 0o2000], ["sticky", 0o1000]].map(([label, bit]) => <label key={label}>{checkbox(Number(bit), String(label))}{label}</label>)}</details>
      {entry.kind === "dir" && <fieldset><legend>Untergeordnete Einträge</legend>
        <label><input type="checkbox" checked={fields.recursive} onChange={event => update({ recursive: event.target.checked })} />Rekursiv anwenden</label>
        {fields.recursive && <><label><input type="radio" name="recursive-mode" checked={!fields.split} onChange={() => update({ split: false })} />Alle Einträge gleich</label>
          <label><input type="radio" name="recursive-mode" checked={fields.split} onChange={() => update({ split: true })} />Ordner und Dateien getrennt</label>
          {fields.split && <><label>Ordner (Oktal)<input value={fields.directories} inputMode="numeric" maxLength={4} aria-invalid={parseOctal(fields.directories) === null} onChange={event => update({ directories: event.target.value })} /></label>
            <label>Dateien (Oktal)<input value={fields.files} inputMode="numeric" maxLength={4} aria-invalid={parseOctal(fields.files) === null} onChange={event => update({ files: event.target.value })} /></label></>}
        </>}
      </fieldset>}
      {!options && <p role="alert">Ungültige Rechte: 3–4 Oktalziffern (0–7) erforderlich.</p>}
      <p>Symlinks werden übersprungen. Bisherige Rechte vor Änderungen merken, um sie bei Bedarf wiederherzustellen.</p>
      <div className="dialog-actions"><button type="submit" disabled={!options}>Anwenden</button><button type="button" onClick={() => onAnswer(null)}>Abbrechen</button></div>
    </form>
  </dialog>;
}
