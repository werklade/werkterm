import { describe, expect, it, vi } from "vitest";
import {
  applyOneKeyMappings, buildSessionTree, commitImport, defaultImportSelection, deselectNewImportDuplicates,
  deleteSession, importDefaultPath, initialSessionAuthType, keyringAvailable, listSessions, markImportDuplicates, previewImport,
  saveSession, searchSessions, sessionLabel, sessionTarget, validateSession,
  type ImportCandidate, type SavedSession,
} from "./sessions";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const sample = (overrides: Partial<SavedSession> = {}): SavedSession => ({
  kind: "ssh", id: "one", name: "Server", folder: "Lab/Linux", host: "server.test", port: 22,
  user: "alice", auth: { type: "default" }, source: null, ...overrides,
});
const candidate = (overrides: Partial<ImportCandidate> = {}): ImportCandidate => ({
  key: "windterm:one", name: "Server", folder: "Lab", host: "server.test", port: 22,
  user: "alice", keyPath: null, oneKey: null, duplicateOf: null, ...overrides,
});

describe("session helpers", () => {
  it("prefers keyring passwords for quick-connect drafts and asks when unavailable", () => {
    const draft = sample({ id: "" });
    expect(initialSessionAuthType(draft, true, true)).toBe("password");
    expect(initialSessionAuthType(draft, true, false)).toBe("ask");
    expect(initialSessionAuthType(undefined, false, true)).toBe("default");
    expect(initialSessionAuthType(draft, false, false)).toBe("default");
  });

  it("retains existing session authentication regardless of keyring availability", () => {
    for (const auth of [{ type: "default" }, { type: "ask" }, { type: "password" },
      { type: "keyFile", path: "id_ed25519" }] as const) {
      expect(initialSessionAuthType(sample({ auth }), true, true)).toBe(auth.type);
      expect(initialSessionAuthType(sample({ auth }), true, false)).toBe(auth.type);
    }
  });

  it("builds and sorts nested folders while retaining root sessions", () => {
    const input = [sample(), sample({ id: "two", name: "Root", folder: "" }),
      sample({ id: "three", folder: "Lab/BSD" }), sample({ id: "four", folder: "Other/Linux" })];
    const tree = buildSessionTree(input);
    expect(tree.sessions.map(item => item.id)).toEqual(["two"]);
    expect(tree.folders.map(item => item.path)).toEqual(["Lab", "Other"]);
    expect(tree.folders[0].folders.map(item => item.path)).toEqual(["Lab/BSD", "Lab/Linux"]);
    expect(tree.folders[0].folders[1].sessions[0].id).toBe("one");
    expect(input[0].id).toBe("one");
    expect(buildSessionTree([]).folders).toEqual([]);
  });

  it("searches names, hosts and nullable users without case sensitivity", () => {
    const sessions = [sample(), sample({ id: "two", name: "Router", host: "edge.test", user: null })];
    expect(searchSessions(sessions, " ALICE ").map(item => item.id)).toEqual(["one"]);
    expect(searchSessions(sessions, "EDGE").map(item => item.id)).toEqual(["two"]);
    expect(searchSessions(sessions, "router").map(item => item.id)).toEqual(["two"]);
    expect(searchSessions(sessions, " ")).toHaveLength(2);
    expect(searchSessions(sessions, "missing")).toEqual([]);
  });

  it("formats explicit ports, optional users and bracketed IPv6 targets", () => {
    expect(sessionTarget(sample())).toBe("alice@server.test:22");
    expect(sessionTarget(sample({ user: null, port: 2200 }), "bob")).toBe("bob@server.test:2200");
    expect(sessionTarget(sample({ user: null }))).toBe("server.test:22");
    expect(sessionTarget(sample({ host: "2001:db8::1" }))).toBe("alice@[2001:db8::1]:22");
    expect(sessionTarget(sample({ host: "[::1]" }))).toBe("alice@[::1]:22");
    expect(sessionLabel(sample())).toBe("alice@server.test");
    expect(sessionLabel(sample({ user: null }))).toBe("server.test");
  });

  it("only preselects candidates not marked as duplicates", () => {
    expect([...defaultImportSelection([candidate(), candidate({ key: "duplicate", duplicateOf: "saved" })])])
      .toEqual(["windterm:one"]);
  });

  it("applies OneKey users and auth without changing the source candidates", () => {
    const candidates = [candidate({ user: null, oneKey: "shared" }), candidate({ key: "key", keyPath: "~/id_ed25519" }),
      candidate({ key: "plain" }), candidate({ key: "unknown", oneKey: "unknown" })];
    const result = applyOneKeyMappings(candidates, { shared: { user: "bob", auth: { type: "ask" } } });
    expect(result.map(item => [item.user, item.auth])).toEqual([
      ["bob", { type: "ask" }], ["alice", { type: "keyFile", path: "~/id_ed25519" }],
      ["alice", { type: "default" }], ["alice", { type: "default" }],
    ]);
    expect(candidates[0].user).toBeNull();
    expect(applyOneKeyMappings([candidate({ user: null, oneKey: "shared" })],
      { shared: { user: null, auth: { type: "default" } } })[0].user).toBeNull();
  });

  it("preserves explicit users, including empty users, while applying OneKey auth", () => {
    const result = applyOneKeyMappings([candidate({ oneKey: "shared" }), candidate({ user: "", oneKey: "shared" })],
      { shared: { user: "bob", auth: { type: "ask" } } });
    expect(result.map(item => [item.user, item.auth])).toEqual([["alice", { type: "ask" }], ["", { type: "ask" }]]);
  });

  it("rechecks final mapped targets and deselects only newly recognized duplicates", () => {
    const candidates = [candidate({ user: null, oneKey: "shared" }),
      candidate({ key: "other-port", port: 2222 }), candidate({ key: "other-user", user: "Alice" }),
      candidate({ key: "known" }), candidate({ key: "stale", host: "other.test", duplicateOf: "old" })];
    const saved = [sample({ host: "SERVER.TEST" })];
    const previous = markImportDuplicates(applyOneKeyMappings(candidates, {}), saved);
    const next = markImportDuplicates(applyOneKeyMappings(candidates,
      { shared: { user: "alice", auth: { type: "default" } } }), saved);
    expect(previous.map(item => item.candidate.duplicateOf)).toEqual([null, null, null, "one", null]);
    expect(next.map(item => item.candidate.duplicateOf)).toEqual(["one", null, null, "one", null]);
    const selected = new Set(candidates.map(item => item.key));
    expect([...deselectNewImportDuplicates(selected, previous, next)])
      .toEqual(["other-port", "other-user", "known", "stale"]);
    expect(selected.size).toBe(5);
    expect(candidates[4].duplicateOf).toBe("old");
  });

  it("validates required fields, integer port range and nonempty key paths", () => {
    expect(validateSession(sample())).toBeNull();
    for (const invalid of [sample({ name: " " }), sample({ host: "bad host" }), sample({ host: "bad\u0000host" }),
      sample({ port: 0 }), sample({ port: 65536 }), sample({ port: 1.5 }), sample({ auth: { type: "keyFile", path: " " } })]) {
      expect(validateSession(invalid)).not.toBeNull();
    }
    expect(validateSession(sample({ port: 65535 }))).toBeNull();
  });
});

describe("session IPC wrappers", () => {
  it("uses backend command names and exact camelCase argument names", async () => {
    const session = sample();
    await listSessions();
    await saveSession(session, null);
    await deleteSession("one");
    await keyringAvailable();
    await importDefaultPath("windterm");
    await previewImport("mobaxterm", "sessions.ini");
    await commitImport([]);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["sessions_list"], ["sessions_save", { session, password: null }],
      ["sessions_delete", { id: "one" }], ["sessions_keyring_available"],
      ["sessions_import_default_path", { source: "windterm" }],
      ["sessions_import_preview", { source: "mobaxterm", path: "sessions.ini" }],
      ["sessions_import_commit", { candidates: [] }],
    ]);
  });
});

it("validates keepalive boundaries with legacy defaults", () => {
  expect(validateSession(sample())).toBeNull();
  for (const keepaliveInterval of [0, 30, 3600]) for (const keepaliveMax of [1, 3, 100])
    expect(validateSession(sample({ keepaliveInterval, keepaliveMax }))).toBeNull();
  for (const keepaliveInterval of [-1, 3601, 1.5, NaN])
    expect(validateSession(sample({ keepaliveInterval }))).toContain("Keepalive");
  for (const keepaliveMax of [0, 101, 1.5, NaN])
    expect(validateSession(sample({ keepaliveMax }))).toContain("Keepalive");
});
