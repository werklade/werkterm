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
export const terminalWriters = new Map<number, (data: string) => void>();
