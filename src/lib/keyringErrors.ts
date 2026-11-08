export function keyringErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (!/\bKEYRING_[A-Z_]+\b/.test(message)) return message;
  if (/\bKEYRING_(UNAVAILABLE|NO_COLLECTION)\b/.test(message)) {
    return "Kein Schlüsselbund verfügbar – Passwort wird beim Verbinden abgefragt.";
  }
  if (/\bKEYRING_LOCKED\b/.test(message)) {
    return "Schlüsselbund ist gesperrt. Bitte entsperren oder Anmeldung 'Beim Verbinden fragen' wählen.";
  }
  return "Schlüsselbund-Operation fehlgeschlagen. Bitte Anmeldung 'Beim Verbinden fragen' wählen.";
}
