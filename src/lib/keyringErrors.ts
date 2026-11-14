import { t } from "../i18n";
import { errorCode, errorText } from "./backendError";

/**
 * Keyring errors get the keyring-specific hint, decided by the error's own code only.
 * Everything else (including codes that merely nest a keyring error, e.g. SESSION_DELETED_KEYRING,
 * and KEYRING_RESTORE_FAILED with its cause) is translated in full by errorText.
 */
export function keyringErrorText(reason: unknown): string {
  const code = errorCode(reason);
  if (!code?.startsWith("KEYRING_") || code === "KEYRING_RESTORE_FAILED") return errorText(reason);
  if (code === "KEYRING_UNAVAILABLE" || code === "KEYRING_NO_COLLECTION") return t("keyring.unavailable");
  if (code === "KEYRING_LOCKED") return t("keyring.locked");
  return t("keyring.failed");
}
