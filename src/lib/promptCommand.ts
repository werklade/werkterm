// LC_ALL=C makes Bash iterate UTF-8 bytes, matching URI percent encoding.
export const SSH_PROMPT_COMMAND = String.raw` __werkterm_osc7() { local LC_ALL=C p="$PWD" out='' c i; for ((i=0;i<${"${#p}"};i++)); do c="${"${p:i:1}"}"; case "$c" in [-_.~a-zA-Z0-9/]) out+="$c";; *) printf -v c '%%%02X' "'$c"; out+="$c";; esac; done; printf '\033]7;file://%s%s\007' "$HOSTNAME" "$out"; }; export PROMPT_COMMAND="__werkterm_osc7${"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"}"` + "\r";

/** Clear the echoed integration command and its old prompt before Bash redraws it. */
export function buildPromptCommand(cols: number, cursorX: number): string {
  const command = SSH_PROMPT_COMMAND.replace(/\r/g, "");
  const width = Number.isFinite(cols) && cols > 0 ? Math.max(1, Math.floor(cols)) : 1;
  const cursor = Number.isFinite(cursorX) ? Math.max(0, cursorX) : 0;
  // The echoed line includes the printf suffix, whose length depends on the row count.
  const suffix = (rows: number) => `; printf '\\033[${rows}A\\r\\033[J'`;
  let rows = 1;
  while (Math.ceil((cursor + command.length + suffix(rows).length) / width) > rows) rows += 1;
  return command + suffix(rows) + "\r";
}

/** Wait for a quiet prompt, bounding continuous login output to five seconds. */
export function createPromptCommandSender(enabled: () => boolean, write: (id: number, data: string) => Promise<void>, report: (error: unknown) => void, dimensions: () => { cols: number; cursorX: number } = () => ({ cols: 80, cursorX: 0 })) {
  let sessionId: number | undefined;
  let receivedData = false;
  let quiet = false;
  let deadline = false;
  let sent = false;
  let stopped = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(quietTimer); clearTimeout(deadlineTimer); };
  const send = () => {
    if (stopped || sent || !receivedData || sessionId === undefined || (!quiet && !deadline) || !enabled()) return;
    sent = true;
    clear();
    const { cols, cursorX } = dimensions();
    void write(sessionId, buildPromptCommand(cols, cursorX)).catch(report);
  };
  return {
    receiveData() {
      if (stopped || sent) return;
      receivedData = true;
      quiet = false;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { quiet = true; send(); }, 400);
      send();
    },
    connect(id: number) {
      if (stopped || sessionId !== undefined) return;
      sessionId = id;
      deadlineTimer = setTimeout(() => { deadline = true; send(); }, 5000);
      send();
    },
    dispose() { stopped = true; clear(); },
  };
}
