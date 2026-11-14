import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { passwordInputReducer } from "../lib/passwordInput";
import { PasswordField } from "./PasswordField";
import { SecretDialog } from "./SecretDialog";
import { SessionDialog, sessionSaveError } from "./SessionDialog";
import type { SavedSession } from "../lib/sessions";

// Exercise dialog callbacks without adding a DOM/test-renderer dependency.
// Only the React hook host is replaced; the password reducer and JSX are real.
const host = vi.hoisted(() => ({
  password: { value: "typed input", visible: true },
  keyring: null as boolean | null,
  answer: vi.fn(), save: vi.fn().mockResolvedValue({}),
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? host.keyring : typeof initial === "function" ? initial() : initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useId: () => "test-dialog",
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useEffect: vi.fn(),
  useReducer: (reducer: typeof passwordInputReducer) => [host.password, (action: Parameters<typeof passwordInputReducer>[1]) => {
    host.password = reducer(host.password, action);
  }],
}));
vi.mock("./useModal", () => ({ useModal: () => ({ current: null }) }));
vi.mock("../lib/sessions", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/sessions")>(),
  saveSession: host.save,
}));

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child)) return child;
    try { return find(child.props.children as ReactNode, predicate); } catch { /* next sibling */ }
  }
  throw new Error("Element not found");
}
function click(node: ReactNode, text: string) {
  const button = find(node, element => element.type === "button" && element.props.children === text);
  (button.props.onClick as () => void)();
}
function submit(node: ReactNode) {
  const form = find(node, element => element.type === "form");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
}
function expectReset() { expect(host.password).toEqual({ value: "", visible: false }); }

const saved: SavedSession = {
  kind: "ssh", id: "existing", name: "Server", folder: "", host: "localhost", port: 22,
  user: "alice", auth: { type: "password" }, source: null,
};
const sessionDialog = () => SessionDialog({ session: saved, sessions: [], onClose: host.answer, onSaved: host.answer });
const secretDialog = () => SecretDialog({ prompt: { type: "secret", requestId: 1, kind: "password", label: "Server" }, onAnswer: host.answer });

beforeEach(() => { host.keyring = null; host.password = { value: "typed input", visible: true }; vi.clearAllMocks(); });

describe("password dialog lifecycle", () => {
  it.each([secretDialog, sessionDialog])("hides and clears the input when cancelling", render => {
    click(render(), "Abbrechen");
    expectReset();
    expect(host.answer).toHaveBeenCalled();
  });
  it.each([secretDialog, sessionDialog])("hides and clears the input on Escape", render => {
    const dialog = render();
    dialog.props.onCancel({ preventDefault() {} });
    expectReset();
  });
  it("submits only the current secret and hides it afterwards", () => {
    submit(secretDialog());
    expect(host.answer).toHaveBeenCalledWith("typed input");
    expectReset();
  });
  it("hides the input on save without losing the submitted password", async () => {
    submit(sessionDialog());
    expect(host.save).toHaveBeenCalledWith(expect.objectContaining({ id: "existing" }), "typed input");
    expectReset();
    await Promise.resolve();
  });
  it("clears and hides the input when the authentication option changes", () => {
    const select = find(sessionDialog(), element => element.type === "select" && element.props.value === "password");
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "ask" } });
    expectReset();
  });
  it("does not populate the password from a saved session", () => {
    host.password = { value: "", visible: false };
    const field = find(sessionDialog(), element => element.type === PasswordField);
    expect(field.props.value).toBe("");
    expect(field.props.visible).toBe(false);
  });
});

describe("password field accessibility and errors", () => {
  it("disables password storage and shows one availability hint without a duplicate alert", () => {
    host.keyring = false;
    const dialog = sessionDialog();
    expect(find(dialog, element => element.type === "option" && element.props.value === "password").props.disabled).toBe(true);
    expect(find(dialog, element => element.type === PasswordField).props.disabled).toBe(true);
    const message = "Kein Schlüsselbund verfügbar – Passwort wird beim Verbinden abgefragt.";
    expect(JSON.stringify(dialog).split(message)).toHaveLength(2);
    expect(() => find(dialog, element => element.props.role === "alert")).toThrow("Element not found");
  });
  it("enables password storage when the keyring is available", () => {
    host.keyring = true;
    expect(find(sessionDialog(), element => element.type === "option" && element.props.value === "password").props.disabled).toBe(false);
  });
  it.each([false, true])("renders visibility %s with an accessible toggle", visible => {
    const toggle = vi.fn();
    const field = PasswordField({ visible, onToggle: toggle, value: "input" });
    expect(find(field, element => element.type === "input").props.type).toBe(visible ? "text" : "password");
    const button = find(field, element => element.type === "button");
    expect(button.props["aria-pressed"]).toBe(visible);
    expect(button.props["aria-label"]).toBe(visible ? "Passwort verbergen" : "Passwort anzeigen");
    (button.props.onClick as () => void)();
    expect(toggle).toHaveBeenCalledOnce();
  });
  it("shows the specific keyring error and the alternative login hint", () => {
    expect(sessionSaveError("KEYRING_LOCKED")).toBe(
      "Schlüsselbund ist gesperrt. Entsperren oder Anmeldung „Beim Verbinden fragen“ wählen.",
    );
    expect(sessionSaveError(new Error("Sitzungsdatei konnte nicht gespeichert werden"))).toBe("Sitzungsdatei konnte nicht gespeichert werden");
  });
});


describe("connection kind dialog", () => {
  const saved = (kind: string): SavedSession => ({ kind, id: "existing", name: "Console", folder: "", host: "router.test", port: 23, user: null, auth: { type: "default" }, source: null, serial: { device: "COM3", baud: 115200, data_bits: 8, parity: "none", stop_bits: 1, flow: "none", enter: "cr", local_echo: false } });
  it.each(["telnet", "serial"])("never submits a password for %s", kind => {
    const dialog = SessionDialog({ session: saved(kind), sessions: [], onClose: host.answer, onSaved: vi.fn() });
    submit(dialog);
    expect(host.save).toHaveBeenCalledWith(expect.objectContaining({ kind, auth: { type: "default" }, jumpSessionId: null }), null);
  });
  it("rejects a missing serial device before saving", () => {
    const session = saved("serial"); session.serial!.device = "";
    submit(SessionDialog({ session, sessions: [], onClose: host.answer, onSaved: vi.fn() }));
    expect(host.save).not.toHaveBeenCalled();
  });
  it("renders the Telnet plaintext warning", () => {
    const dialog = SessionDialog({ session: saved("telnet"), sessions: [], onClose: host.answer, onSaved: vi.fn() });
    expect(find(dialog, element => element.props.role === "note").props.children).toContain("Telnet ist unverschlüsselt");
  });
});
