import { describe, expect, it } from "vitest";
import { childPath, parentPath } from "./paths";

describe("parentPath", () => {
  it.each([["/a/b", "/a"], ["/a", "/"], ["/", "/"], ["/a/b/", "/a"], ["C:/a", "C:/"], ["C:/", "C:/"], ["C:/a/b", "C:/a"], ["C:\\a\\b", "C:/a"], ["", ""]])("returns parent of %s", (path, expected) => expect(parentPath(path)).toBe(expected));
  it("joins directory entries without duplicate separators", () => {
    expect(childPath("/", "home")).toBe("/home");
    expect(childPath("C:/", "Users")).toBe("C:/Users");
  });
  it("handles native canonical Windows paths and UNC share roots", () => {
    expect(parentPath("\\\\?\\C:\\Users\\Marc")).toBe("C:/Users");
    expect(parentPath("\\\\?\\C:\\")).toBe("C:/");
    expect(childPath("\\\\?\\C:\\Users", "Marc")).toBe("C:/Users/Marc");
    expect(parentPath("\\\\?\\UNC\\server\\share\\folder")).toBe("//server/share");
    expect(parentPath("\\\\server\\share")).toBe("//server/share");
  });
  it("preserves literal backslashes in POSIX names", () => {
    expect(parentPath("/tmp/a\\b/child")).toBe("/tmp/a\\b");
    expect(parentPath("/tmp/a\\b")).toBe("/tmp");
    expect(childPath("/tmp/a\\b", "c\\d")).toBe("/tmp/a\\b/c\\d");
  });
});
