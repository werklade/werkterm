import { describe, expect, it } from "vitest";
import { parseQuickConnect } from "./quickConnect";

describe("parseQuickConnect", () => {
  it.each([
    ["alice@example.org", { user: "alice", host: "example.org", port: 22 }],
    [" user@192.168.0.1:2222 ", { user: "user", host: "192.168.0.1", port: 2222 }],
    ["root@[::1]", { user: "root", host: "::1", port: 22 }],
    ["root@[2001:db8::1]:65535", { user: "root", host: "2001:db8::1", port: 65535 }],
    ["a@localhost:1", { user: "a", host: "localhost", port: 1 }],
  ])("parses %s", (input, target) => expect(parseQuickConnect(input)).toEqual(target));

  it.each(["", "host", "@host", "user@", "user@host:0", "user@host:70000", "user@host:-1", "user@host:", "user@host:22x", "user@::1", "user@[::gg]", "user@[1:2]", "user@999.1.1.1", "user@-host", "user@a..b", "user name@host", "user@host name", "a@b@c"])("rejects %s", input => expect(parseQuickConnect(input)).toBeNull());
});
