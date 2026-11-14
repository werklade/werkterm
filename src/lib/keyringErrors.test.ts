import { expect, it } from "vitest";
import { keyringErrorText } from "./keyringErrors";

it.each(["UNAVAILABLE", "NO_COLLECTION"])("explains missing keyring %s", code => {
  expect(keyringErrorText(`KEYRING_${code}`)).toBe(
    "Kein Schlüsselbund verfügbar – Passwort wird beim Verbinden abgefragt.",
  );
});
it.each(["LOCKED", "FAILED", "FUTURE_CODE"])("gives the keyring hint for KEYRING_%s without its payload", code => {
  const text = keyringErrorText(new Error(`KEYRING_${code}: {"detail":"private"}`));
  expect(text).not.toContain("KEYRING_");
  expect(text).not.toContain("private");
  expect(text).toContain("Beim Verbinden fragen");
});
it("classifies by the error's own code, not by nested codes", () => {
  expect(keyringErrorText('SESSION_DELETED_KEYRING: {"args":{"error":"KEYRING_LOCKED"}}'))
    .toBe("Sitzung wurde gelöscht; Schlüsselbund: Schlüsselbund ist gesperrt");
  expect(keyringErrorText('KEYRING_RESTORE_FAILED: {"args":{"error":"SESSIONS_SAVE_FAILED"}}'))
    .toBe("Sitzungsdatei konnte nicht gespeichert werden; vorheriger Schlüsselbund-Eintrag konnte nicht wiederhergestellt werden");
  expect(keyringErrorText("SSH_AUTH_FAILED")).toBe("SSH-Authentifizierung fehlgeschlagen");
});
it("preserves unrelated actionable errors", () => {
  expect(keyringErrorText(new Error("Disk full"))).toBe("Disk full");
});
