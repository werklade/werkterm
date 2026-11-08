import { describe, expect, it } from "vitest";
import { parseSerialPermission, permissionMode, type SerialPermission, type FixOptions } from "./serialPermission";
const info: SerialPermission = { device: "/dev/ttyUSB0", group: "tty", username: "marc", guessed: false, already_member: false, os_id: "debian", os_id_like: "" };
const fixes: FixOptions = { options: [], missing: ["sudo"], install_hint: "apt install sudo", root_command: "usermod -aG 'tty' 'marc'" };
describe("serial permission decisions", () => {
  it("prioritizes existing membership", () => {
    expect(permissionMode({ ...info, already_member: true }, null)).toBe("member");
    expect(permissionMode({ ...info, already_member: true }, fixes)).toBe("member");
  });
  it("distinguishes loading, options and missing tools", () => {
    expect(permissionMode(info, null)).toBe("loading");
    expect(permissionMode(info, fixes)).toBe("missing");
    expect(permissionMode(info, { ...fixes, options: [{ label: "sudo + usermod", command: "sudo usermod -aG 'tty' 'marc'", needs_root_password: false, hint: "" }] })).toBe("options");
  });
  it("only accepts structured permission errors", () => {
    expect(parseSerialPermission("SERIAL_PERMISSION:" + JSON.stringify(info))).toEqual(info);
    for (const error of ["ordinary error", "SERIAL_PERMISSION:{", "SERIAL_PERMISSION:null", "SERIAL_PERMISSION:{}"]) expect(parseSerialPermission(error)).toBeNull();
  });
});
