import { Channel, invoke } from "@tauri-apps/api/core";
import type { UpdateChannelSetting } from "./settings";
import { normalizeProgress, type InstallRequest, type UpdateCheck, type UpdateInfo, type UpdateProgress } from "./updateState";

/** Local only, no network. `channel` is the per-device setting; WERKTERM_UPDATE_CHANNEL overrides it in the backend. */
export const updateInfo = (channel: UpdateChannelSetting) => invoke<UpdateInfo>("update_info", { channel });
/** One of the two commands that touch the network (with update_install); only called on user action or the opt-in start check. */
export const updateCheck = (channel: UpdateChannelSetting) => invoke<UpdateCheck>("update_check", { channel });
/**
 * Downloads and installs; the caller restarts afterwards (app_restart). There is no cancel command.
 * The backend repeats the check and refuses when it now finds another version than `request.version`, or a
 * downgrade without `allowDowngrade`.
 */
export const updateInstall = (request: InstallRequest, onProgress: (progress: UpdateProgress) => void) => {
  const channel = new Channel<UpdateProgress | { done: true }>();
  // The backend ends with { done: true }; it carries no numbers and must not reset the bar.
  channel.onmessage = message => { if (!("done" in message)) onProgress(normalizeProgress(message)); };
  return invoke<void>("update_install", { channel: request.channel, version: request.version, allowDowngrade: request.allowDowngrade, onProgress: channel });
};
