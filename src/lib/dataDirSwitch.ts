import { errorText } from "./backendError";
export interface SwitchSteps {
  flushSettings(): Promise<void>;
  stopTunnels(): Promise<void>;
  saveLastTabs(): Promise<void>;
  stopLogs(): Promise<void>;
  /** data_dir_set: the point of no return. */
  setDataDir(): Promise<void>;
  /** Called right after a successful setDataDir: blocks every write path. */
  lock(): void;
  restart(): Promise<void>;
  /** The restart failed after the switch; the UI offers only "Neu starten". */
  onRestartFailed(message: string): void;
}

/**
 * Order of a data folder switch: everything that can fail first, the switch itself last, directly before the
 * restart. A rejection before setDataDir propagates (nothing was switched, everything stays writable); after it
 * the lock is set and a failing restart is only reported.
 */
export async function runSwitch(steps: SwitchSteps): Promise<void> {
  await steps.flushSettings();
  await steps.stopTunnels();
  await steps.saveLastTabs();
  await steps.stopLogs();
  await steps.setDataDir();
  steps.lock();
  try { await steps.restart(); } catch (reason) { steps.onRestartFailed(errorText(reason)); }
}
