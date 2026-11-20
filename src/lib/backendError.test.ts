import { describe, expect, it } from "vitest";
import { errorCode, errorText, parseBackendError } from "./backendError";
import { setLanguage } from "../i18n";

describe("parseBackendError", () => {
  it("parses bare codes, args, detail and legacy text", () => {
    expect(parseBackendError("SESSION_CLOSED")).toEqual({ code: "SESSION_CLOSED", args: {} });
    expect(parseBackendError('EXISTS: {"args":{"name":"a.txt"}}')).toEqual({ code: "EXISTS", args: { name: "a.txt" } });
    expect(parseBackendError(new Error('CANCELLED: {"detail":"eof"}'))).toEqual({ code: "CANCELLED", args: {}, detail: "eof" });
    expect(parseBackendError("SUDO_DENIED: sudo nicht erlaubt")).toEqual({ code: "SUDO_DENIED", args: {}, text: "sudo nicht erlaubt" });
    expect(parseBackendError("CONFLICT: {kaputt")).toEqual({ code: "CONFLICT", args: {}, text: "{kaputt" });
    expect(parseBackendError("Verbindung abgelehnt")).toBeNull();
    expect(parseBackendError("A")).toBeNull();
    expect(errorCode('EXISTS: {"args":{"name":"x"}}')).toBe("EXISTS");
    expect(errorCode("Fehler")).toBeUndefined();
  });
});

describe("errorText", () => {
  it("translates bare codes", () => {
    expect(errorText("SESSION_CLOSED")).toBe("Die SSH-Sitzung ist geschlossen. Der Editor bleibt mit dem Inhalt geöffnet.");
  });
  it("fills args", () => {
    expect(errorText('EXISTS: {"args":{"name":"a.txt"}}')).toBe("a.txt existiert bereits");
    expect(errorText('WRITE_FAILED: {"args":{"backup":"C:\\\\cache\\\\x"}}')).toContain("Sicherung: C:\\cache\\x");
  });
  it("translates a nested error arg", () => {
    const inner = 'SSH_AUTH_FAILED: {"detail":"eof"}';
    const outer = `SSH_JUMP_HOST: ${JSON.stringify({ args: { name: "gw", error: inner } })}`;
    expect(errorText(outer)).toBe("Sprungserver gw: SSH-Authentifizierung fehlgeschlagen: eof");
    expect(errorText(`SSH_JUMP_HOST: ${JSON.stringify({ args: { name: "a", error: outer } })}`))
      .toBe("Sprungserver a: Sprungserver gw: SSH-Authentifizierung fehlgeschlagen: eof");
  });
  it("appends the untranslated detail", () => {
    expect(errorText('CANCELLED: {"detail":"os error 2"}')).toBe("Übertragung abgebrochen: os error 2");
  });
  it("shows legacy free text unchanged", () => {
    expect(errorText("SUDO_DENIED: sudo ist hier verboten")).toBe("sudo ist hier verboten");
    expect(errorText("SESSION_CLOSED:")).toBe("Die SSH-Sitzung ist geschlossen. Der Editor bleibt mit dem Inhalt geöffnet.");
  });
  it("keeps plain text and unknown codes unchanged", () => {
    expect(errorText("Verbindung abgelehnt")).toBe("Verbindung abgelehnt");
    expect(errorText(new Error("Disk full"))).toBe("Disk full");
    expect(errorText('FUTURE_CODE: {"args":{"x":"1"}}')).toBe('FUTURE_CODE: {"args":{"x":"1"}}');
    expect(errorText("FUTURE_CODE")).toBe("FUTURE_CODE");
  });
  it("uses English when the language is en", () => {
    setLanguage("en");
    try {
      expect(errorText('EXISTS: {"args":{"name":"a.txt"}}')).toBe("a.txt already exists");
      expect(errorText('CANCELLED: {"detail":"eof"}')).toBe("Transfer cancelled: eof");
    } finally { setLanguage("de"); }
  });
});

describe("plural forms and nested error lists", () => {
  it("chooses .one/.other by the count arg", () => {
    expect(errorText('IMPORT_PASSWORDS_ASK: {"args":{"count":"1"}}')).toBe("1 Sitzung fragt beim Verbinden nach dem Passwort (Passwörter werden nicht exportiert)");
    expect(errorText('IMPORT_PASSWORDS_ASK: {"args":{"count":"5"}}')).toBe("5 Sitzungen fragen beim Verbinden nach dem Passwort (Passwörter werden nicht exportiert)");
    expect(errorText("IMPORT_PASSWORDS_ASK")).toBe("IMPORT_PASSWORDS_ASK");
  });
  it("translates every entry of an errors list including the tunnel name", () => {
    const errors = JSON.stringify([
      'TUNNEL_START_FAILED: {"args":{"error":"TUNNEL_PORT_IN_USE: {\\"args\\":{\\"port\\":\\"8080\\"}}","name":"Database"}}',
      'TUNNEL_START_FAILED: {"args":{"error":"TUNNEL_DISCONNECTED","name":"Web"}}',
    ]);
    const wire = `TUNNEL_AUTOSTART_FAILED: ${JSON.stringify({ args: { count: "2", errors } })}`;
    expect(errorText(wire)).toBe("2 Tunnel nicht gestartet: Tunnel Database: Port 8080 ist bereits belegt; Tunnel Web: SSH-Verbindung getrennt");
    setLanguage("en");
    try {
      expect(errorText(wire)).toBe("2 tunnels not started: Tunnel Database: Port 8080 is already in use; Tunnel Web: SSH connection lost");
    } finally { setLanguage("de"); }
  });
  it("adds the cleanup outcome of a failed data folder switch to the original error", () => {
    const inner = 'DATA_FILE_COPY_FAILED: {"args":{"name":"designs"},"detail":"os error 112"}';
    const cleaned = `DATA_DIR_COPY_ROLLED_BACK: ${JSON.stringify({ args: { error: inner } })}`;
    expect(errorText(cleaned)).toBe("designs konnte nicht kopiert werden: os error 112; Teilkopie entfernt");
    const left = (count: string) => `DATA_DIR_COPY_ROLLBACK_INCOMPLETE: ${JSON.stringify({ args: { error: inner, count, path: "D:\\Daten" } })}`;
    expect(errorText(left("1"))).toBe("designs konnte nicht kopiert werden: os error 112; Teilkopie nicht vollständig entfernt, 1 Eintrag bleibt in D:\\Daten");
    expect(errorText(left("3"))).toBe("designs konnte nicht kopiert werden: os error 112; Teilkopie nicht vollständig entfernt, 3 Einträge bleiben in D:\\Daten");
    setLanguage("en");
    try {
      expect(errorText(cleaned)).toBe("designs could not be copied: os error 112; partial copy removed");
      expect(errorText(left("3"))).toBe("designs could not be copied: os error 112; partial copy not fully removed, 3 entries remain in D:\\Daten");
    } finally { setLanguage("de"); }
  });
});
