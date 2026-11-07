import { describe, expect, it } from "vitest";
import { chmodOptions, modeToRwx, octal, parseOctal, rwxToMode, togglePermission } from "./permissions";

describe("permissions", () => {
  it("roundtrips all modes including special bits", () => {
    for (let mode = 0; mode <= 0o7777; mode++) {
      expect(rwxToMode(modeToRwx(mode))).toBe(mode);
      expect(parseOctal(octal(mode))).toBe(mode);
    }
    expect(modeToRwx(0o7700)).toBe("rws--S--T");
  });
  it("rejects invalid octal and symbolic modes", () => {
    for (const value of ["", "77", "888", "10000", "-755", " 755", "755 "]) expect(parseOctal(value)).toBeNull();
    expect(rwxToMode("rwxrwxrws")).toBeNull();
    expect(rwxToMode("rwxrwxrwz")).toBeNull();
  });
  it("links checkbox bits without dropping special bits", () => {
    expect(togglePermission(0o4755, 0o020, true)).toBe(0o4775);
    expect(togglePermission(0o4755, 0o4000, false)).toBe(0o755);
  });
  it("validates split fields only when recursive split is enabled", () => {
    const fields = { value: "4755", recursive: false, split: true, directories: "bad", files: "644" };
    expect(chmodOptions(fields)).toEqual({ mode: 0o4755, recursive: false, scope: "all", dirMode: null, fileMode: null });
    expect(chmodOptions({ ...fields, recursive: true })).toBeNull();
    expect(chmodOptions({ ...fields, recursive: true, directories: "755" })).toEqual({ mode: 0o4755, recursive: true, scope: "all", dirMode: 0o755, fileMode: 0o644 });
    expect(chmodOptions({ ...fields, value: "invalid" })).toBeNull();
  });
});
