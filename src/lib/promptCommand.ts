// Keep the leading space and literal backslash escapes for the remote shell.
export const SSH_PROMPT_COMMAND = " export PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\007\" \"$HOSTNAME\" \"$PWD\"'\"${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"\r";

/** Coordinates IPC data that can arrive before ssh_connect resolves. */
export function createPromptCommandSender(enabled: () => boolean, write: (id: number, data: string) => Promise<void>, report: (error: unknown) => void) {
  let sessionId: number | undefined;
  let receivedData = false;
  let sent = false;
  let stopped = false;
  const send = () => {
    if (stopped || sent || !receivedData || sessionId === undefined || !enabled()) return;
    sent = true;
    void write(sessionId, SSH_PROMPT_COMMAND).catch(report);
  };
  return {
    receiveData() { receivedData = true; send(); },
    connect(id: number) { sessionId = id; send(); },
    dispose() { stopped = true; },
  };
}
