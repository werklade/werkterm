import { describe, expect, it } from "vitest";
import { terminalNotice } from "./terminalNotice";
import { setLanguage } from "../i18n";

describe("terminalNotice", () => {
  it("ignores output bytes and foreign values", () => {
    expect(terminalNotice(new Uint8Array([65]).buffer)).toBeNull();
    expect(terminalNotice(null)).toBeNull();
    expect(terminalNotice("text")).toBeNull();
    expect(terminalNotice({ notice: 1 })).toBeNull();
  });
  it("translates coded notices and strips control characters", () => {
    expect(terminalNotice({ notice: 'SERIAL_REMOVED: {"args":{"device":"/dev/ttyUSB0"}}' })).toBe("\r\n[Gerät /dev/ttyUSB0 entfernt]\r\n");
    expect(terminalNotice({ notice: 'TELNET_CONNECTION_LOST: {"detail":"reset\\r\\n"}' })).toBe("\r\n[Telnet-Verbindung unterbrochen: reset  ]\r\n");
    setLanguage("en");
    try {
      expect(terminalNotice({ notice: 'SERIAL_REMOVED: {"args":{"device":"COM3"}}' })).toBe("\r\n[Device COM3 removed]\r\n");
    } finally { setLanguage("de"); }
  });
});
