import { useEffect, useReducer, useRef, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { updateCheck, updateInfo } from "../lib/update";
import { guardLate, initialUpdateState, interpretCheck, updateReducer, type AvailableUpdate, type UpdateCheck, type UpdateProgress } from "../lib/updateState";
import { UpdateDialogView } from "./UpdateDialogView";

export interface UpdateDialogProps {
  /**
   * Runs the whole install: confirmations (SSH, editors), preparation, download with progress, restart.
   * Resolves true when it ran through, false when the user declined a confirmation; rejects with the message to show.
   */
  onInstall(onProgress: (progress: UpdateProgress) => void): Promise<boolean>;
  /** Result of a completed check (not called on errors); null = up to date. */
  onChecked?(update: AvailableUpdate | null): void;
  onClose(): void;
}

const message = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

/**
 * Opening the dialog is the user's action that starts the check (update_info is local, update_check is the
 * network call). The phase transitions are in updateReducer; this component only starts the call that belongs to
 * a phase, once per entry into the phase.
 */
export function UpdateDialog({ onInstall, onChecked, onClose }: UpdateDialogProps) {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);
  const [copyNote, setCopyNote] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const entered = useRef<string | null>(null);
  // Answers that arrive after the dialog was closed are dropped (the network call itself cannot be aborted).
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  const late = <T,>(handler: (value: T) => void) => guardLate(() => open.current, handler);
  useEffect(() => {
    if (entered.current === state.phase) return; // StrictMode probe and progress updates do not start a second call
    entered.current = state.phase;
    if (state.phase === "loading") {
      updateInfo().then(info => dispatch({ type: "info", info })).catch((reason: unknown) => dispatch({ type: "failed", message: message(reason) }));
    } else if (state.phase === "checking") {
      updateCheck().then(late((check: UpdateCheck) => {
        const outcome = interpretCheck(check);
        if (outcome.ok) onChecked?.(outcome.update);
        dispatch({ type: "checked", check });
      })).catch((reason: unknown) => dispatch({ type: "failed", message: message(reason) }));
    } else if (state.phase === "installing") {
      onInstall(progress => dispatch({ type: "progress", progress }))
        .then(done => dispatch({ type: done ? "installed" : "declined" }))
        .catch((reason: unknown) => dispatch({ type: "failed", message: message(reason) }));
    }
  }, [state.phase]);
  // Focus follows the content: primary action, else the close button, while installing the progress bar.
  useEffect(() => {
    document.querySelector<HTMLElement>(".update-dialog [data-initial-focus]")?.focus();
  }, [state.phase]);
  const copy = (text: string) => {
    setCopyFailed(false);
    writeClipboardText(text).then(() => setCopyNote("Kopiert")).catch((reason: unknown) => { setCopyFailed(true); setCopyNote(message(reason)); });
  };
  return <UpdateDialogView state={state} copyNote={copyNote} copyFailed={copyFailed} onClose={onClose}
    onInstall={() => dispatch({ type: "install" })} onRetry={() => { setCopyNote(""); dispatch({ type: "retry" }); }} onCopy={copy} />;
}
