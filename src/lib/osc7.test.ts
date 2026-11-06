import { describe, expect, it } from "vitest";
import { parseOsc7 } from "./osc7";

describe("parseOsc7", () => {
  it.each([
    ["file://server/home/user", { host: "server", path: "/home/user" }],
    ["file:///", { host: "", path: "/" }],
    ["file://PC/C:/Users/x", { host: "PC", path: "C:/Users/x" }],
    ["file://host/tmp/a%20b%23%C3%A4", { host: "host", path: "/tmp/a b#ä" }],
    ["file://host/tmp/%ZZ", { host: "host", path: "/tmp/%ZZ" }],
  ])("parses %s", (input, expected) => expect(parseOsc7(input)).toEqual(expected));
  it.each(["", "/home/x", "https://host/path", "file://host", "file://bad host/path", "file://host/\u0007"])("rejects %s", input => expect(parseOsc7(input)).toBeNull());
});
