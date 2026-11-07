export interface Recipient { id: number; exited: boolean; checked: boolean }
export const gridColumns = (count: number): number => Math.max(1, Math.ceil(Math.sqrt(Math.max(0, count))));
export function inputTargets(focused: number, terminals: readonly Recipient[]): number[] {
  const source = terminals.find(t => t.id === focused);
  if (!source || source.exited) return [];
  return terminals.filter(t => !t.exited && (t.id === focused || (source.checked && t.checked))).map(t => t.id);
}
export function pasteLines(data: string): number {
  const plain = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
  return /[\r\n]/.test(plain) ? plain.split(/\r\n|\r|\n/).length : 0;
}
export const requiresPasteConfirmation = (multiExec: boolean, pasted: boolean, data: string): boolean =>
  multiExec && pasted && pasteLines(data) > 0;
export const terminalWriters = new Map<number, (data: string, pasted?: boolean) => void>();

export function encodePaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n|\n/g, "\r");
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}

// xterm 6's public onData omits provenance. Keep this version-specific bridge
// isolated: the core marks keyboard/IME input synchronously, even for delayed IME.
// Unknown future implementations fail closed (all data stays in its own session).
export function inputProvenance(terminal: unknown) {
  const core = (terminal as { _core?: { coreService?: { triggerDataEvent(data: string, user?: boolean): void } } })._core?.coreService;
  let userInput = false;
  const original = core?.triggerDataEvent;
  const wrapped = function (this: NonNullable<typeof core>, data: string, user = false) {
    const previous = userInput;
    userInput = user;
    try { original!.call(this, data, user); } finally { userInput = previous; }
  };
  if (core && original) core.triggerDataEvent = wrapped;
  return { isUserInput: () => userInput, dispose: () => { if (core && original && core.triggerDataEvent === wrapped) core.triggerDataEvent = original; } };
}
