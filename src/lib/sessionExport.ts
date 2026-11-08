import { save } from "@tauri-apps/plugin-dialog";
import { exportSessions } from "./sessions";

export async function chooseSessionExport(ids: string[], onStatus: (message: string) => void): Promise<void> {
  try {
    const path = await save({ title: "Sitzungen exportieren", defaultPath: `werkterm-sitzungen-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "Werkterm-Sitzungen", extensions: ["json"] }] });
    if (!path) return;
    const count = await exportSessions(ids, path);
    onStatus(`${count} Sitzungen exportiert nach ${path} (ohne Passwörter)`);
  } catch (reason) {
    onStatus(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "Sitzungen konnten nicht exportiert werden.");
  }
}
