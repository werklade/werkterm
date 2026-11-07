import { describe, expect, it } from "vitest";
import { languageFromShebang } from "./editorLanguage";

describe("shebang language detection", () => {
  it.each([
    ["#!/bin/bash\necho hi", "shell"], ["#!/bin/sh", "shell"], ["#!/usr/bin/env python\nprint(1)", "python"],
    ["#!/usr/bin/python3.12 -u", "python"], ["#!/usr/bin/env -S python3 -u", "python"],
    ["#!/usr/bin/env LANG=C node", "javascript"], ["#!/usr/bin/ruby", "ruby"], ["#!/usr/bin/perl", "perl"], ["#!/usr/bin/php", "php"],
  ])("detects %s", (source, expected) => expect(languageFromShebang(source)).toBe(expected));
  it("does not infer from ordinary content or unsupported interpreters", () => {
    expect(languageFromShebang("echo hello\n#!/bin/bash")).toBeNull();
    expect(languageFromShebang("#!/usr/bin/unknown")).toBeNull();
    expect(languageFromShebang("")).toBeNull();
  });
});
