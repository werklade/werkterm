import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { choicePath, dataDirInspect, describeInspect, type ChoiceFeedback, type DataDirChoice, type DataDirStatus } from "../lib/dataDir";
import { DataDirForm, type DataDirMode, type DataDirView } from "./DataDirForm";

export interface DataDirDialogProps {
  mode: DataDirMode;
  status: DataDirStatus;
  /** Preselected folder (change mode); it is inspected on mount. */
  initialChoice?: DataDirChoice;
  /** Applies the choice (`path === null` = default folder). Rejects with a message shown in the dialog. */
  onApply(path: string | null, copyCurrent: boolean): Promise<void>;
  /** Unreachable mode: resolves true when the folder is reachable again. */
  onRetry?(): Promise<boolean>;
  onCancel?(): void;
  notice?: string;
}

export async function pickDataDir(): Promise<string | null> {
  const path = await open({ directory: true, multiple: false, title: "Datenordner wählen" });
  return typeof path === "string" ? path : null;
}

export function DataDirDialog({ mode, status, initialChoice, onApply, onRetry, onCancel, notice }: DataDirDialogProps) {
  const [view, setView] = useState<DataDirView>(mode === "unreachable" ? "unreachable" : "choose");
  const [choice, setChoice] = useState<DataDirChoice | null>(initialChoice ?? null);
  const [feedback, setFeedback] = useState<ChoiceFeedback | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const allowSame = mode !== "change";

  const inspect = (next: DataDirChoice) => {
    const id = ++request.current;
    const current = () => id === request.current;
    setChoice(next); setFeedback(null); setError(""); setInspecting(true);
    dataDirInspect(next.path)
      .then(info => { if (current()) setFeedback(describeInspect(info, { allowSame })); })
      .catch((reason: unknown) => { if (current()) setFeedback({ tone: "error", message: String(reason), canConfirm: false, showCopy: false }); })
      .finally(() => { if (current()) setInspecting(false); });
  };
  useEffect(() => { if (initialChoice) inspect(initialChoice); }, []);

  const apply = async (path: string | null, copyCurrent: boolean) => {
    setBusy(true); setError("");
    try { await onApply(path, copyCurrent); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const pick = async () => {
    setError("");
    try {
      const path = await pickDataDir();
      if (path !== null) { setView("choose"); inspect({ kind: "folder", path }); }
    } catch (reason) { setError(String(reason)); }
  };
  const useDefault = () => {
    // Setup and unreachable: the explicit button is the choice. Change: inspect first, confirm with "Übernehmen".
    if (mode === "change") { inspect({ kind: "default", path: status.defaultPath }); return; }
    void apply(null, false);
  };
  const retry = async () => {
    setBusy(true); setError("");
    try { if (!(await onRetry?.())) setError("Datenordner weiterhin nicht erreichbar."); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const submit = () => {
    if (!choice || !feedback?.canConfirm) return;
    void apply(choicePath(choice), feedback.showCopy && copy);
  };
  return <DataDirForm mode={mode} view={view} status={status} choice={choice} feedback={feedback} inspecting={inspecting} copy={copy} busy={busy} error={error}
    onPick={() => void pick()} onDefault={useDefault} onCopy={setCopy} onSubmit={submit} onRetry={() => void retry()} onBack={() => { setView("unreachable"); setError(""); }} onCancel={onCancel} notice={notice} />;
}
