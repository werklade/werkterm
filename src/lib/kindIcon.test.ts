import { expect, it } from "vitest";
import { kindIcon } from "./kindIcon";
it("maps connection types and local shells", () => {
  for (const kind of ["ssh", "telnet", "serial"] as const) expect(kindIcon(kind)).toBe(kind);
  expect(kindIcon("editor")).toBe("edit"); expect(kindIcon("wsl")).toBe("tux");
  expect(kindIcon("local", "PowerShell")).toBe("powershell"); expect(kindIcon("local", "pwsh.exe")).toBe("powershell");
  expect(kindIcon("local", "cmd.exe")).toBe("windows"); expect(kindIcon("local", "/bin/bash")).toBe("tux");
  expect(kindIcon("local", "/bin/sh")).toBe("terminal"); expect(kindIcon("unknown")).toBe("terminal");
});
