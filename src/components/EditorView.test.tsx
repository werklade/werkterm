import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, interpretLoaded } from "../lib/settings";
import EditorView, { type EditorHandle } from "./EditorView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/pinchZoom", () => ({ registerPinchTarget: () => () => {} }));
vi.mock("./useModal", () => ({ useModal: () => ({ current: null }) }));
vi.mock("@codemirror/view", async importOriginal => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  class TestView {
    static theme = actual.EditorView.theme;
    static editable = actual.EditorView.editable;
    static updateListener = actual.EditorView.updateListener;
    constructor({ state }: { state: import("@codemirror/state").EditorState }) { this.state = state; }
    state: import("@codemirror/state").EditorState;
    dispatch() {}
    destroy() {}
  }
  return { ...actual, EditorView: TestView };
});

// Run the editor's hooks and real JSX with a stand-in for CodeMirror's DOM.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    return hooks.values[index] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  useImperativeHandle: (ref: { current: unknown }, create: () => unknown) => { ref.current = create(); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

type Element = ReactElement<Record<string, unknown>>;
function find(tree: ReactNode, match: (element: Element) => boolean): Element | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (match(child)) return child;
    const nested = find(child.props.children as ReactNode, match);
    if (nested) return nested;
  }
}

type Props = ComponentProps<typeof EditorView>;
const remote = { host: "Production", sudo: true };
function mount(source: "local" | "wsl" | "ssh", settings = defaultSettings) {
  hooks.values = [];
  const ref = { current: null as EditorHandle | null };
  const props: Props = {
    document: {
      docId: 1, name: "config", path: source === "wsl" ? "/mnt/c/config" : "/etc/config",
      text: "data\n", bom: false, eol: "lf", eolCounts: { lf: 1, crLf: 0, cr: 0 },
      size: 5, mtime: null, readonly: false,
    },
    remote: source === "ssh" ? remote : undefined,
    settings, onDirtyChange: vi.fn(), onStatusChange: vi.fn(),
  };
  const render = () => {
    hooks.index = 0;
    hooks.effects = [];
    return (EditorView as unknown as { render(props: Props, ref: unknown): ReactNode }).render(props, ref);
  };
  const tree = render();
  const code = find(tree, element => element.props.className === "editor-code")!;
  (code.props.ref as { current: unknown }).current = { addEventListener() {}, removeEventListener() {} };
  const cleanups = hooks.effects.map(effect => effect());
  const windows = find(tree, element => element.props["aria-label"] === "Windows-Zeilenenden (CRLF)")!;
  (windows.props.onClick as () => void)();
  return {
    handle: ref.current!,
    render,
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

function dialog(editor: ReturnType<typeof mount>) {
  const choice = find(editor.render(), element => "choice" in element.props);
  if (!choice) return;
  const component = choice.type as (props: Element["props"]) => Element;
  return component(choice.props);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ size: 6, mtime: null });
});

describe("remote editor save confirmation", () => {
  it("shows the remote path, host and sudo warning, and keeps the document dirty on Escape", async () => {
    const editor = mount("ssh");
    const saving = editor.handle.save();
    const prompt = dialog(editor)!;
    expect(prompt.props["aria-label"]).toBe("Datei auf dem Server überschreiben?");
    expect(find(prompt, el => String(el.props.children).startsWith("/etc/config auf Production"))).toBeDefined();
    expect(find(prompt, el => el.props.children === "Die Datei wurde im sudo-Modus geöffnet und wird als root geschrieben.")).toBeDefined();
    expect(find(prompt, el => el.props["data-autofocus"] === true)?.props.children).toBe("Auf Server speichern");
    expect(invoke).not.toHaveBeenCalled();

    (prompt.props.onCancel as (event: unknown) => void)({ preventDefault: vi.fn() });
    expect(await saving).toBe(false);
    expect(editor.handle.isDirty()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(find(editor.render(), el => el.props.role === "alert")).toBeUndefined();
    editor.unmount();
  });

  it.each(["local", "wsl"] as const)("saves %s files directly", async source => {
    const editor = mount(source);
    const saving = editor.handle.save();
    expect(dialog(editor)).toBeUndefined();
    expect(await saving).toBe(true);
    expect(invoke).toHaveBeenCalledWith("editor_save", expect.objectContaining({ docId: 1, eol: "crLf" }));
    editor.unmount();
  });

  it("leaves Enter on a focused button to that button", async () => {
    const editor = mount("ssh");
    const saving = editor.handle.save();
    const prompt = dialog(editor)!;
    const preventDefault = vi.fn();
    (prompt.props.onKeyDown as (event: unknown) => void)({
      key: "Enter", target: { tagName: "BUTTON" }, preventDefault, stopPropagation: vi.fn(),
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(dialog(editor)).toBeDefined();
    editor.unmount();
    expect(await saving).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("editor_save", expect.anything());
  });

  it("remembers confirmation only until the editor tab closes", async () => {
    const editor = mount("ssh");
    const saving = editor.handle.save();
    const checkbox = find(dialog(editor), el => el.props.type === "checkbox")!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    const prompt = dialog(editor)!;
    (prompt.props.onKeyDown as (event: unknown) => void)({
      key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    expect(await saving).toBe(true);

    const nextSave = editor.handle.save();
    expect(dialog(editor)).toBeUndefined();
    expect(await nextSave).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    editor.unmount();

    const reopened = mount("ssh");
    const reopenedSave = reopened.handle.save();
    expect(dialog(reopened)).toBeDefined();
    reopened.unmount();
    expect(await reopenedSave).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("saves remote files directly when confirmation is disabled", async () => {
    const editor = mount("ssh", { ...defaultSettings, confirmRemoteSave: false });
    const saving = editor.handle.save();
    expect(dialog(editor)).toBeUndefined();
    expect(await saving).toBe(true);
    expect(invoke).toHaveBeenCalledWith("editor_save", expect.objectContaining({ docId: 1 }));
    editor.unmount();
  });

  it("enables confirmation for older saved settings", () => {
    expect(interpretLoaded('{"editorWrap":true}', null)).toMatchObject({
      ok: true, settings: { confirmRemoteSave: true },
    });
  });
});
