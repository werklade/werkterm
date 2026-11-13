import { save } from "@tauri-apps/plugin-dialog";
import { t, tp } from "../i18n";
import { exportSessions } from "./sessions";

export async function chooseSessionExport(ids: string[], onStatus: (message: string) => void): Promise<void> {
  try {
    const path = await save({ title: t("session.export.title"), defaultPath: t("session.export.fileName", { date: new Date().toISOString().slice(0, 10) }),
      filters: [{ name: t("session.export.filter"), extensions: ["json"] }] });
    if (!path) return;
    const count = await exportSessions(ids, path);
    onStatus(tp("session.export.done", count, { path }));
  } catch (reason) {
    onStatus(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : t("session.export.failed"));
  }
}
