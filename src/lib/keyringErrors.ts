import { t } from "../i18n";

export function keyringErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (!/\bKEYRING_[A-Z_]+\b/.test(message)) return message;
  if (/\bKEYRING_(UNAVAILABLE|NO_COLLECTION)\b/.test(message)) return t("keyring.unavailable");
  if (/\bKEYRING_LOCKED\b/.test(message)) return t("keyring.locked");
  return t("keyring.failed");
}
