import { describe, expect, it } from "vitest";
import { formatBytes, isLoopback, sessionRoute, statusText, validateTunnel, type Tunnel, type TunnelStatus } from "./tunnels";
import type { SavedSession } from "./sessions";
const session: SavedSession = { id: "ssh", kind: "ssh", name: "Server", host: "host", port: 22, folder: "", user: null, auth: { type: "default" }, source: null };
const tunnel: Tunnel = { id: "one", name: "DB", kind: "local", session_id: "ssh", bind_address: "127.0.0.1", bind_port: 8080, target_host: "db", target_port: 5432, autostart: false, reconnect: false, allow_public: false };
describe("tunnel validation", () => {
  it("accepts valid kinds and remote port zero", () => {
    expect(validateTunnel(tunnel, [session])).toBe("");
    expect(validateTunnel({ ...tunnel, kind: "remote", bind_port: 0 }, [session])).toBe("");
    expect(validateTunnel({ ...tunnel, kind: "dynamic", target_host: "", target_port: null }, [session])).toBe("");
  });
  it("rejects invalid ports, hosts, sessions and unconfirmed public binds", () => {
    for (const patch of ofInvalid()) expect(validateTunnel({ ...tunnel, ...patch }, [session])).not.toBe("");
    expect(validateTunnel(tunnel, [{ ...session, kind: "local" }])).not.toBe("");
    expect(validateTunnel({ ...tunnel, bind_address: "0.0.0.0", allow_public: true }, [session])).toBe("");
  });
});
function* ofInvalid(): Generator<Partial<Tunnel>> {
  yield { name: " " }; yield { session_id: "missing" };
  for (const bind_port of [0, -1, 65536, 1.2, NaN]) yield { bind_port };
  for (const target_port of [0, -1, 65536, null]) yield { target_port };
  for (const target_host of ["", "bad host", "bad\thost", "bad\0host"]) yield { target_host };
  yield { bind_address: "0.0.0.0" }; yield { bind_address: "::" }; yield { bind_address: "gateway.example", allow_public: true }; yield { kind: "dynamic" };
}
describe("loopback", () => {
  it("accepts IPv4 loopback range, IPv6 and localhost", () => { for (const host of ["127.0.0.1", "127.12.34.56", "::1", "0:0:0:0:0:0:0:1", "0::1", "::0001", "localhost", "LOCALHOST"]) expect(isLoopback(host)).toBe(true); });
  it("rejects public and misleading addresses", () => { for (const host of ["0.0.0.0", "::", "192.168.0.1", "localhost.evil", "127.0.0.1.evil", "127.256.0.1"]) expect(isLoopback(host)).toBe(false); });
});
it("formats status and byte directions", () => {
  expect(statusText()).toBe("Gestoppt");
  const status: TunnelStatus = { id: "one", state: "error", error: "Port 8080 ist bereits belegt", connections: 0, bytes_in: 0, bytes_out: 0, bound_port: null };
  expect(statusText(status)).toBe("Fehler: Port 8080 ist bereits belegt");
  expect(statusText({ ...status, state: "running", error: null })).toBe("Aktiv");
  expect(formatBytes(0)).toBe("0 B"); expect(formatBytes(1024)).toBe("1,0 KiB"); expect(formatBytes(1048576)).toBe("1,0 MiB");
});
it("shows the jump chain", () => { expect(sessionRoute("ssh", [{ ...session, jumpSessionId: "jump" }, { ...session, id: "jump", name: "Gateway" }])).toBe("Server über Gateway"); });
