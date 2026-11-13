import { Channel, invoke } from "@tauri-apps/api/core";
import { normalizeProgress, type UpdateCheck, type UpdateInfo, type UpdateProgress } from "./updateState";

/** Local only, no network. */
export const updateInfo = () => invoke<UpdateInfo>("update_info");
/** One of the two commands that touch the network (with update_install); only called on user action or the opt-in start check. */
export const updateCheck = () => invoke<UpdateCheck>("update_check");
/** Downloads and installs; the caller restarts afterwards (app_restart). There is no cancel command. */
export const updateInstall = (onProgress: (progress: UpdateProgress) => void) => {
  const channel = new Channel<UpdateProgress | { done: true }>();
  // The backend ends with { done: true }; it carries no numbers and must not reset the bar.
  channel.onmessage = message => { if (!("done" in message)) onProgress(normalizeProgress(message)); };
  return invoke<void>("update_install", { onProgress: channel });
};
