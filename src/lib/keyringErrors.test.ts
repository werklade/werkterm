import { expect, it } from "vitest";
import { keyringErrorText } from "./keyringErrors";

it.each(["UNAVAILABLE", "NO_COLLECTION"])("explains missing keyring %s", code => {
  expect(keyringErrorText(`KEYRING_${code}: private provider text`)).toBe(
    "Kein Schlüsselbund verfügbar – Passwort wird beim Verbinden abgefragt.",
  );
});
it.each(["LOCKED", "FAILED", "FUTURE_CODE"])("never exposes %s codes or provider text", code => {
  const text = keyringErrorText(new Error(`Sitzung wurde gelöscht; KEYRING_${code}: private`));
  expect(text).not.toContain("KEYRING_");
  expect(text).not.toContain("private");
  expect(text).toContain("Beim Verbinden fragen");
});
it("preserves unrelated actionable errors", () => {
  expect(keyringErrorText(new Error("Disk full"))).toBe("Disk full");
});
