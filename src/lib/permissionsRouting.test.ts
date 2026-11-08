import { describe, expect, it } from "vitest";
import { permissionRoute } from "./permissions";
describe("permission routing", () => {
  it("keeps SFTP available on every host", () => {
    expect(permissionRoute("sftp", "/home", true)).toBe("sftp");
    expect(permissionRoute("sftp", "/home", false)).toBe("sftp");
  });
  it("allows local Unix and rejects Windows, WSL, UNC and exec", () => {
    expect(permissionRoute("local", "/home", false)).toBe("local");
    expect(permissionRoute("local", "C:/home", true)).toBeNull();
    expect(permissionRoute("local", "/home", false, true)).toBeNull();
    for (const path of [String.raw`\\wsl$\Ubuntu`, String.raw`\\wsl.localhost\Ubuntu`, "//server/share", String.raw`\wsl$\Ubuntu`]) {
      expect(permissionRoute("local", path, false)).toBeNull();
    }
    expect(permissionRoute("exec", "/home", false)).toBeNull();
    expect(permissionRoute(null, "/home", false)).toBeNull();
  });
});
