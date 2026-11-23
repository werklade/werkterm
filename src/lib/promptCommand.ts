// LC_ALL=C makes Bash iterate UTF-8 bytes, matching URI percent encoding.
// PROMPT_COMMAND is not exported and checks for the function, because child shells
// (pct enter, su, tmux) may inherit the variable without the function.
export const SSH_PROMPT_COMMAND = String.raw` __werkterm_osc7() { local LC_ALL=C p="$PWD" out='' c i; for ((i=0;i<${"${#p}"};i++)); do c="${"${p:i:1}"}"; case "$c" in [-_.~a-zA-Z0-9/]) out+="$c";; *) printf -v c '%%%02X' "'$c"; out+="$c";; esac; done; printf '\033]7;file://%s%s\007' "$HOSTNAME" "$out"; }; PROMPT_COMMAND="declare -F __werkterm_osc7 >/dev/null && __werkterm_osc7${"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"}"; [[ $(history 1) == *__werkterm_osc7*PROMPT_COMMAND* ]] && history -d $HISTCMD 2>/dev/null` + "\r";

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

/** What the cursor line looks like: a shell prompt, something that must not receive the command
 * (password or yes/no question, full-screen program), or anything else. */
export type PromptState = "prompt" | "blocked" | "other";

/**
 * Send once output has been quiet for 400 ms and the prompt is recognised. If the prompt is never
 * recognised, the first quiet period after the five second deadline sends anyway, unless the cursor
 * line is blocked. Gives up after 15 seconds or as soon as the user types. Nothing is sent unless the
 * login shell was confirmed as Bash (network device CLIs would reject the line as an invalid command).
 */
export function createPromptCommandSender(enabled: () => boolean, write: (id: number, data: string) => Promise<void>, report: (error: unknown) => void, dimensions: () => { cols: number; cursorX: number } = () => ({ cols: 80, cursorX: 0 }), promptState: () => PromptState = () => "prompt") {
  let sessionId: number | undefined;
  let receivedData = false;
  let quiet = false;
  let deadline = false;
  let sent = false;
  let stopped = false;
  // Set once the login shell check resolved to true; the command is Bash-only.
  let bash = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(quietTimer); clearTimeout(deadlineTimer); clearTimeout(giveUpTimer); };
  const send = () => {
    if (stopped || sent || !bash || !receivedData || sessionId === undefined || !quiet || !enabled()) return;
    const state = promptState();
    if (state === "blocked" || (state !== "prompt" && !deadline)) return;
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
    },
    /** `isBash` must resolve to true before anything is sent; false or a rejection stops for good. */
    connect(id: number, isBash: Promise<boolean>) {
      if (stopped || sessionId !== undefined) return;
      sessionId = id;
      deadlineTimer = setTimeout(() => { deadline = true; send(); }, 5000);
      giveUpTimer = setTimeout(() => { stopped = true; clear(); }, 15000);
      const notBash = () => { stopped = true; clear(); };
      isBash.then(result => {
        if (result !== true) { notBash(); return; }
        bash = true;
        send();
      }, notBash);
    },
    /** The user typed: never inject into their input. */
    userInput() { stopped = true; clear(); },
    dispose() { stopped = true; clear(); },
  };
}
