export interface CloseTab { kind: string; exited: boolean; sessionId?: number }
export function activeSshTabs<T extends CloseTab>(tabs: readonly T[]): T[] {
  return tabs.filter(tab => ["ssh", "telnet", "serial"].includes(tab.kind) && !tab.exited && tab.sessionId !== undefined);
}
export function shouldConfirmSsh(tabs: readonly CloseTab[], enabled: boolean): boolean {
  return enabled && activeSshTabs(tabs).length > 0;
}
/** SSH approval always precedes the editor sequence; cancellation never starts it. */
export async function closeAfterSsh(ask: () => Promise<boolean>, editors: () => Promise<boolean>): Promise<boolean> {
  return await ask() && await editors();
}
