export interface Settings {
  followTerminalFolder: boolean;
  shellIntegration: boolean;
  sshPromptCommand: boolean;
}

export const defaultSettings: Settings = {
  followTerminalFolder: true,
  shellIntegration: true,
  sshPromptCommand: true,
};
const storageKey = "werkterm.settings";

export function loadSettings(): Settings {
  try {
    const stored: unknown = JSON.parse((localStorage.getItem(storageKey) ?? localStorage.getItem(storageKey.replace(/^werkterm\./, "linmoba."))) ?? "null");
    if (typeof stored !== "object" || stored === null) return { ...defaultSettings };
    const values = stored as Record<string, unknown>;
    return {
      followTerminalFolder: typeof values.followTerminalFolder === "boolean" ? values.followTerminalFolder : true,
      shellIntegration: typeof values.shellIntegration === "boolean" ? values.shellIntegration : true,
      sshPromptCommand: typeof values.sshPromptCommand === "boolean" ? values.sshPromptCommand : true,
    };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: Settings): void {
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Settings remain usable for this session. */ }
}
