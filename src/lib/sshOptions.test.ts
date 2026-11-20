import { describe, expect, it } from "vitest";
import { checkSshOptions, legacySshAlgorithms, MAX_SSH_OPTION_LINES, sshOptionsOverrideKeepalive, utf8Length } from "./sshOptions";
import { parseQuickConnect, quickConnectSshArgs, splitQuickConnectOptions, withQuickConnectUser } from "./quickConnect";
import { sshOptionsError, validateSession, type SavedSession } from "./sessions";
import { setLanguage } from "../i18n";

const session = (sshOptions?: string, kind = "ssh"): SavedSession => ({ kind, id: "a", name: "Old", host: "server.test", port: 22, folder: "", user: "root", auth: { type: "default" }, source: null, ...(sshOptions === undefined ? {} : { sshOptions }) });

describe("SSH option text", () => {
  it("accepts -o, Key=Value and Key Value lines case-insensitively", () => {
    expect(checkSshOptions("")).toBeNull();
    expect(checkSshOptions("-o KexAlgorithms=+diffie-hellman-group14-sha1\nciphers aes128-cbc\n\n# comment\nMACS = hmac-sha1\r\n-oConnectTimeout=30\nPubkeyAcceptedKeyTypes \"+ssh-rsa\"")).toBeNull();
  });
  it("reports the line of malformed, unknown and duplicate options", () => {
    expect(checkSshOptions("Ciphers aes128-ctr\n\nProxyCommand nc %h %p")).toEqual({ kind: "unknown", line: 3, key: "ProxyCommand" });
    expect(checkSshOptions("Ciphers")).toEqual({ kind: "malformed", line: 1 });
    expect(checkSshOptions("ConnectTimeout 5\nCiphers a b")).toEqual({ kind: "malformed", line: 2 });
    expect(checkSshOptions("=aes128-ctr")).toEqual({ kind: "malformed", line: 1 });
    expect(checkSshOptions("PubkeyAcceptedKeyTypes +ssh-rsa\npubkeyacceptedalgorithms +ssh-rsa")).toEqual({ kind: "duplicate", line: 2, key: "pubkeyacceptedalgorithms" });
    expect(checkSshOptions("ConnectTimeout 5\n".repeat(MAX_SSH_OPTION_LINES + 1))).toEqual({ kind: "tooLong" });
    expect(checkSshOptions(`Ciphers ${"a".repeat(5000)}`)).toEqual({ kind: "tooLong" });
  });
  it("lists explicitly enabled weak algorithms only", () => {
    expect(legacySshAlgorithms("KexAlgorithms +diffie-hellman-group1-sha1,curve25519-sha256\nHostKeyAlgorithms ^ssh-rsa\nCiphers 3des-cbc,AES128-CBC\nMACs hmac-sha1"))
      .toEqual(["diffie-hellman-group1-sha1", "ssh-rsa", "3des-cbc", "aes128-cbc", "hmac-sha1"]);
    expect(legacySshAlgorithms("HostKeyAlgorithms -ssh-rsa\nCiphers +aes256-ctr")).toEqual([]);
  });
});

describe("quick connect with -o options", () => {
  it("parses options before the target", () => {
    expect(parseQuickConnect("-o KexAlgorithms=+diffie-hellman-group14-sha1 root@host")).toEqual({ user: "root", host: "host", port: 22, sshOptions: ["KexAlgorithms=+diffie-hellman-group14-sha1"] });
    expect(parseQuickConnect(" -oCiphers=aes128-cbc  -o ConnectTimeout=5 root@[::1]:2222 ")).toEqual({ user: "root", host: "::1", port: 2222, sshOptions: ["Ciphers=aes128-cbc", "ConnectTimeout=5"] });
    expect(parseQuickConnect("root@host")).toEqual({ user: "root", host: "host", port: 22 });
  });
  it.each(["-o root@host", "-o Foo=bar root@host", "-o Ciphers root@host", "-o Ciphers=aes128-cbc", "root@host -o Ciphers=aes128-cbc",
    "-o Ciphers=a -o ciphers=b root@host", "-o Ciphers=aes128-cbc telnet://host", "-x Ciphers=aes128-cbc root@host", "-o Ciphers=aes128-cbc a b"])("rejects %s", input => expect(parseQuickConnect(input)).toBeNull());
  it("builds the IPC arguments and keeps options when asking for the user", () => {
    expect(quickConnectSshArgs("-o Ciphers=aes128-cbc -oMACs=hmac-sha1 root@host:2")).toEqual({ target: "root@host:2", sshOptions: "Ciphers=aes128-cbc\nMACs=hmac-sha1" });
    expect(quickConnectSshArgs("root@host")).toEqual({ target: "root@host", sshOptions: null });
    expect(withQuickConnectUser("-oCiphers=aes128-cbc host", "admin")).toBe("-o Ciphers=aes128-cbc admin@host");
    expect(withQuickConnectUser("host:2222", "admin")).toBe("admin@host:2222");
    expect(splitQuickConnectOptions("-o ConnectTimeout=5 host")).toEqual({ options: ["ConnectTimeout=5"], target: "host" });
  });
});

describe("session validation with SSH options", () => {
  it("accepts valid options and stays compatible with sessions without the field", () => {
    expect(validateSession(session())).toBeNull();
    expect(validateSession(session("KexAlgorithms=+diffie-hellman-group14-sha1\nServerAliveInterval 15"))).toBeNull();
  });
  it("names the faulty line and rejects options for non-SSH sessions", () => {
    setLanguage("en");
    expect(validateSession(session("Ciphers aes128-ctr\nProxyJump x"))).toBe("SSH options, line 2: option “ProxyJump” is not supported");
    expect(sshOptionsError("Ciphers")).toBe("SSH options, line 1: expected Option=Value");
    expect(validateSession(session("ConnectTimeout 5", "telnet"))).not.toBeNull();
    setLanguage("de");
  });
});

describe("SSH option limits and hints", () => {
  it("counts UTF-8 bytes like the backend", () => {
    expect(utf8Length("ä")).toBe(2);
    expect(checkSshOptions(`#${"ä".repeat(2047)}`)).toBeNull();
    expect(checkSshOptions(`#${"ä".repeat(2048)}`)).toEqual({ kind: "tooLong" });
    expect(checkSshOptions(`#${"a".repeat(4095)}`)).toBeNull();
  });
  it("detects options that override the keepalive fields", () => {
    expect(sshOptionsOverrideKeepalive("serveraliveinterval 10")).toBe(true);
    expect(sshOptionsOverrideKeepalive("-o ServerAliveCountMax=5")).toBe(true);
    expect(sshOptionsOverrideKeepalive("ConnectTimeout 5\n# ServerAliveInterval 1")).toBe(false);
  });
});
