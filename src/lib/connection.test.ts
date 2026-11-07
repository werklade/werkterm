import { describe, expect, it } from "vitest";
import { parseQuickConnect } from "./quickConnect";
import { connectionStatus, connectionTitle } from "./connection";
import { defaultSerial, sessionTarget, validateSession, type SavedSession } from "./sessions";
import { activeSshTabs } from "./sshClose";
import { terminalDescriptors } from "./history";
const session = (kind: string): SavedSession => ({ kind, id: "a", name: "Test", host: "server.test", port: kind === "telnet" ? 23 : 22, folder: "", user: null, auth: { type: "default" }, source: null, serial: { ...defaultSerial, device: "COM3" } });
describe("Telnet and serial connections", () => {
  it("parses telnet default, explicit and IPv6 ports without changing SSH", () => {
    expect(parseQuickConnect("telnet://server.test")).toEqual({ kind: "telnet", user: null, host: "server.test", port: 23 });
    expect(parseQuickConnect("telnet://server.test:2323")?.port).toBe(2323);
    expect(parseQuickConnect("telnet://[::1]:2323")?.host).toBe("::1");
    for (const target of ["telnet://a:0", "telnet://a:65536", "telnet://u@a", "telnet://", "telnet://a/path"]) expect(parseQuickConnect(target)).toBeNull();
    expect(parseQuickConnect("alice@server.test")).toEqual({ user: "alice", host: "server.test", port: 22 });
  });
  it("parses free serial devices and baud rates", () => {
    expect(parseQuickConnect("serial:///dev/ttyUSB0@9600")).toMatchObject({ kind: "serial", host: "/dev/ttyUSB0", baud: 9600 });
    expect(parseQuickConnect("serial://COM3")?.baud).toBe(115200);
    expect(parseQuickConnect("serial://COM3@0")).toBeNull();
    expect(parseQuickConnect("serial://COM3@4294967296")).toBeNull();
  });
  it("validates the same session draft used by the dialog for each kind", () => {
    for (const kind of ["ssh", "telnet", "serial"]) expect(validateSession(session(kind))).toBeNull();
    expect(validateSession({ ...session("serial"), host: "", serial: { ...defaultSerial, device: "COM3" } })).toBeNull();
    for (const kind of ["ssh", "telnet"]) {
      expect(validateSession({ ...session(kind), host: "bad host" })).not.toBeNull();
      expect(validateSession({ ...session(kind), port: 0 })).not.toBeNull();
    }
    for (const kind of ["telnet", "serial"]) {
      expect(validateSession({ ...session(kind), auth: { type: "password" } })).not.toBeNull();
      expect(validateSession({ ...session(kind), jumpSessionId: "gateway" })).not.toBeNull();
    }
    for (const serial of [null, { ...defaultSerial, device: "" }, { ...defaultSerial, device: "COM3", data_bits: 9 }, { ...defaultSerial, device: "COM3", baud: 0 }]) expect(validateSession({ ...session("serial"), serial })).not.toBeNull();
  });
  it("formats terminal titles and status including 8N1", () => {
    const config = { ...defaultSerial, device: "COM3" };
    expect(connectionStatus("serial", config)).toBe("COM3 115200 8N1");
    expect(connectionStatus("serial", { ...config, parity: "even", stop_bits: 2 })).toBe("COM3 115200 8E2");
    expect(connectionStatus("telnet")).toBe("Telnet – unverschlüsselt");
    expect(connectionTitle("telnet", "telnet://server.test")).toBe("server.test:23");
    expect(connectionTitle("serial", "", config)).toBe("COM3@115200");
    expect(connectionTitle("serial", "", config, "Console")).toBe("Console");
    expect(sessionTarget(session("serial"))).toBe("serial://COM3@115200");
  });
  it("includes both kinds in close confirmation and restore descriptors", () => {
    const tabs = ["telnet", "serial"].map((kind, i) => ({ kind: kind as "telnet" | "serial", id: i, sessionId: i, title: kind, browserPath: "", target: kind === "telnet" ? "telnet://server.test" : "serial://COM3", exited: false }));
    expect(activeSshTabs(tabs)).toHaveLength(2);
    expect(terminalDescriptors(tabs)).toEqual(tabs.map(tab => ({ type: "quick", target: tab.target })));
  });
});
