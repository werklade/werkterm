import { useState } from "react";
import type { DirEntry } from "../lib/fs";
import { chmodOptions, modeToRwx, octal, parseOctal, togglePermission, type ChmodOptions, type PermissionFields } from "../lib/permissions";
import { useModal } from "./useModal";
import { useT, type TextKey } from "../i18n";

const whoKeys: TextKey[] = ["permissions.who.owner", "permissions.who.group", "permissions.who.others"];
const rightKeys: [TextKey, number][] = [["permissions.read", 4], ["permissions.write", 2], ["permissions.execute", 1]];

export function PermissionsDialog({ entry, onAnswer }: { entry: DirEntry; onAnswer: (options: ChmodOptions | null) => void }) {
  const t = useT();
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
      <h2 id="permissions-title">{t("permissions.title", { name: entry.name })}</h2>
      <p>{t("permissions.owner", { owner: entry.user ?? entry.uid ?? t("permissions.unknown"), group: entry.group ?? entry.gid ?? t("permissions.unknown") })}</p>
      <p>{t("permissions.current")} <code>{modeToRwx(entry.permissions)}</code></p>
      <table><thead><tr><th scope="col">{t("permissions.colPermission")}</th>{whoKeys.map(who => <th scope="col" key={who}>{t(who)}</th>)}</tr></thead>
        <tbody>{rightKeys.map(([label, bit]) => <tr key={label}><th scope="row">{t(label)}</th>{whoKeys.map((who, index) => <td key={who}>{checkbox(bit << ((2 - index) * 3), t("permissions.cellLabel", { who: t(who), permission: t(label) }))}</td>)}</tr>)}</tbody></table>
      <label>{t("permissions.octal")} <input autoFocus value={fields.value} inputMode="numeric" maxLength={4} aria-invalid={parseOctal(fields.value) === null} onChange={event => { const value = event.target.value; update({ value }); const next = parseOctal(value); if (next !== null) setLastMode(next); }} /></label>
      <details><summary>{t("permissions.advanced")}</summary>{[["setuid", 0o4000], ["setgid", 0o2000], ["sticky", 0o1000]].map(([label, bit]) => <label key={label}>{checkbox(Number(bit), String(label))}{label}</label>)}</details>
      {entry.kind === "dir" && <fieldset><legend>{t("permissions.children")}</legend>
        <label><input type="checkbox" checked={fields.recursive} onChange={event => update({ recursive: event.target.checked })} />{t("permissions.recursive")}</label>
        {fields.recursive && <><label><input type="radio" name="recursive-mode" checked={!fields.split} onChange={() => update({ split: false })} />{t("permissions.sameForAll")}</label>
          <label><input type="radio" name="recursive-mode" checked={fields.split} onChange={() => update({ split: true })} />{t("permissions.separate")}</label>
          {fields.split && <><label>{t("permissions.foldersOctal")}<input value={fields.directories} inputMode="numeric" maxLength={4} aria-invalid={parseOctal(fields.directories) === null} onChange={event => update({ directories: event.target.value })} /></label>
            <label>{t("permissions.filesOctal")}<input value={fields.files} inputMode="numeric" maxLength={4} aria-invalid={parseOctal(fields.files) === null} onChange={event => update({ files: event.target.value })} /></label></>}
        </>}
      </fieldset>}
      {!options && <p role="alert">{t("permissions.invalid")}</p>}
      <p>{t("permissions.note")}</p>
      <div className="dialog-actions"><button type="submit" disabled={!options}>{t("permissions.apply")}</button><button type="button" onClick={() => onAnswer(null)}>{t("common.cancel")}</button></div>
    </form>
  </dialog>;
}
