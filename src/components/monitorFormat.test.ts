import { describe, it, expect } from "vitest";
import { size, rate, uptime, users, distro, history, dfTable, orderDisks, fittingCount } from "./monitorFormat";
describe("monitor formatters", () => {
 it("formats German sizes and rates", () => { expect(size(1500000)).toBe("1,5 MB"); expect(size(1e12)).toBe("1,0 TB"); expect(rate(null)).toBe("–"); });
 it("formats short and full uptimes", () => { expect(uptime(268658)).toBe("3 Tage"); expect(uptime(18000)).toBe("5 h"); expect(uptime(720)).toBe("12 min"); expect(uptime(268658, true)).toBe("3 Tage, 2 h, 37 min (268658 Sekunden)"); });
 it("deduplicates names without exposing login details", () => { expect(users(["alice pts/0 (10.0.0.1)", "alice pts/1", "bob pts/2", "carol pts/3"])).toBe("alice (x2), bob +1"); expect(users(["root pts/0"])).toBe("root"); expect(users([])).toBe("–"); });
 it("detects distros and bounds history", () => { expect(distro("debian")).toBe("debian"); expect(distro("ubuntu")).toBe("ubuntu"); expect(distro("alpine")).toBe("alpine"); expect(distro(null)).toBe("tux"); expect(history(Array(60).fill(1), 12)).toEqual([...Array(59).fill(1), 12]); });
 it("aligns df columns", () => { const table = dfTable([{device:"/dev/a",mount:"/",usedPercent:50,sizeBytes:1000000,usedBytes:500000,freeBytes:500000},{device:"long-filesystem",mount:"/data",usedPercent:1,sizeBytes:1e12,usedBytes:1e10,freeBytes:9.9e11}]); const lines=table.split("\n"); expect(lines[1].lastIndexOf("/")).toBe(lines[2].indexOf("/data")); expect(table).toContain("Dateisystem"); expect(table).toContain("1,0 TB"); });
});
it("orders system mounts before user mounts and the rest", () => {
  const mounts = ["/srv/data", "/mnt/raid1", "/tmp", "/opt", "/boot/efi", "/", "/media/usb", "/boot"].map(mount => ({ mount }));
  expect(orderDisks(mounts).map(d => d.mount)).toEqual(["/", "/boot", "/boot/efi", "/tmp", "/media/usb", "/mnt/raid1", "/srv/data", "/opt"]);
});
it("fits as many fields as the width allows and keeps room for +N", () => {
  expect(fittingCount([100, 100, 100], 400)).toBe(3);
  expect(fittingCount([100, 100, 100], 250)).toBe(2);
  expect(fittingCount([100, 100, 100], 230)).toBe(1);
  expect(fittingCount([100], 50)).toBe(0);
});
