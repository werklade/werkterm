import { describe, expect, it } from "vitest";
import { parseOsc7 } from "./osc7";

describe("parseOsc7", () => {
  it.each([
    ["file://server/home/user", { host: "server", path: "/home/user" }],
    ["file:///", { host: "", path: "/" }],
    ["file://PC/C:/Users/x", { host: "PC", path: "/C:/Users/x" }],
    ["file://host/tmp/a%20b%23%C3%A4", { host: "host", path: "/tmp/a b#ä" }],
    ["file://host/tmp/%25", { host: "host", path: "/tmp/%" }],
    ["file://host/tmp/%2520", { host: "host", path: "/tmp/%20" }],
    ["file://host/tmp/a%20b", { host: "host", path: "/tmp/a b" }],
    ["file://host/tmp/%ZZ", { host: "host", path: "/tmp/%ZZ" }],
  ])("parses %s", (input, expected) => expect(parseOsc7(input)).toEqual(expected));
  it("normalizes drive paths only for local Windows terminals", () => {
    expect(parseOsc7("file://PC/C:/x", true)?.path).toBe("C:/x");
    expect(parseOsc7("file://PC/C:/x", false)?.path).toBe("/C:/x");
  });
  it("preserves UNC paths emitted by local PowerShell", () => {
    expect(parseOsc7("file://PC//server/share/a%20b", true)?.path).toBe("//server/share/a b");
    expect(parseOsc7("file://server/share/a%20b", true)?.path).toBe("//server/share/a b");
    expect(parseOsc7("file://server/share/a%20b", false)?.path).toBe("/share/a b");
  });
  it.each(["", "/home/x", "https://host/path", "file://host", "file://bad host/path", "file://host/\u0007"])("rejects %s", input => expect(parseOsc7(input)).toBeNull());
});
