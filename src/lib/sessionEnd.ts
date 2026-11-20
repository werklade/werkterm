export interface EndedTexts { title: string; close: string; restart: string; save: string }

const plain = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ");

/** Closing block after a session ended or failed: the optional failure line, then the Return/R/S hints. */
export function endedText(texts: EndedTexts, failure?: string): string {
  const reason = failure === undefined ? "\r\n" : `\r\n\x1b[31m${plain(failure)}\x1b[0m\r\n`;
  return `${reason}\r\n\x1b[1;33m${texts.title}\x1b[0m\r\n    - \x1b[1m<Return>\x1b[0m: ${texts.close}\r\n    - \x1b[1mR\x1b[0m: ${texts.restart}\r\n    - \x1b[1mS\x1b[0m: ${texts.save}\r\n`;
}

export interface SessionEndHandlers {
  /** The running session ended (shell exit, server close, keepalive timeout, network loss). */
  lost(): void;
  /** Starting the session failed (connect/resolve timeout, auth error, cancelled login, ...). */
  failed(error: unknown): void;
}

/**
 * Lifecycle of one terminal session: starting -> running -> ended, or starting -> ended.
 * Every path ends exactly once in the same closed state. An exit event that arrives while
 * the start is still pending is held back: a following failure reports its error, a
 * following success turns into a regular end.
 */
export function createSessionEnd(handlers: SessionEndHandlers) {
  let state: "starting" | "running" | "ended" = "starting";
  let exitWhileStarting = false;
  return {
    get ended() { return state === "ended"; },
    /** The start resolved. Returns false if the session already ended meanwhile. */
    started(): boolean {
      if (state !== "starting") return false;
      if (exitWhileStarting) { state = "ended"; handlers.lost(); return false; }
      state = "running";
      return true;
    },
    failed(error: unknown) {
      if (state === "ended") return;
      state = "ended";
      handlers.failed(error);
    },
    exit() {
      if (state === "ended") return;
      if (state === "starting") { exitWhileStarting = true; return; }
      state = "ended";
      handlers.lost();
    },
  };
}
