import { expect, it } from "vitest";
import { asciiRows, searchAscii } from "./ascii";
it("provides all ASCII and Latin-1 values without gaps", () => {
  const rows = [...asciiRows(), ...asciiRows(true)];
  expect(rows.map(row => row.decimal)).toEqual(Array.from({ length: 256 }, (_, i) => i));
  expect(rows[10]).toMatchObject({ hex: "0A", octal: "012", character: "\\n / ^J", name: "LF – Zeilenvorschub" });
  expect(rows[127].name).toContain("DEL");
  expect(rows[233].character).toBe("é");
  expect(rows[255].character).toBe("ÿ");
});
it("searches names, characters, decimal and hex", () => {
  for (const query of ["Zeilenvorschub", "0x0a", "10", "0A", "\\n", "^J"]) expect(searchAscii(asciiRows(), query).some(row => row.decimal === 10)).toBe(true);
  expect(searchAscii(asciiRows(true), "é").map(row => row.decimal)).toEqual([201, 233]);
});
