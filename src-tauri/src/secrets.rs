//! OS-backed secrets. Never include provider errors (which can contain secret bytes) in messages.
const SERVICE: &str = "de.marck.linmoba";
const UNAVAILABLE: &str = "Kein Schlüsselbund verfügbar (Secret Service läuft nicht)";

pub fn error_message(error: &keyring::Error) -> String {
    match error {
        keyring::Error::NoDefaultStore | keyring::Error::NoStorageAccess(_) => UNAVAILABLE.into(),
        _ => "Schlüsselbund-Operation fehlgeschlagen".into(),
    }
}

fn live_available() -> bool {
    if keyring::Entry::store_status().is_err() {
        return false;
    }
    matches!(
        keyring::Entry::new(SERVICE, "availability:readonly")
            .and_then(|entry| entry.get_password()),
        Ok(_) | Err(keyring::Error::NoEntry)
    )
}

fn operation_error(error: &keyring::Error) -> String {
    // The v1 facade hides platform-specific error types. A separate, read-only
    // probe distinguishes an unavailable store from an entry-specific failure.
    if matches!(error, keyring::Error::PlatformFailure(_)) && !live_available() {
        UNAVAILABLE.into()
    } else {
        error_message(error)
    }
}

pub async fn available() -> bool {
    tauri::async_runtime::spawn_blocking(live_available)
        .await
        .unwrap_or(false)
}

pub async fn set_password(account: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(SERVICE, &account)
            .and_then(|entry| entry.set_password(&password))
            .map_err(|error| operation_error(&error))
    })
    .await
    .map_err(|_| "Schlüsselbund-Operation fehlgeschlagen".to_owned())?
}

pub async fn get_password(account: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match keyring::Entry::new(SERVICE, &account).and_then(|entry| entry.get_password()) {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(operation_error(&error)),
        }
    })
    .await
    .map_err(|_| "Schlüsselbund-Operation fehlgeschlagen".to_owned())?
}

pub async fn delete_password(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        match keyring::Entry::new(SERVICE, &account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(operation_error(&error)),
        }
    })
    .await
    .map_err(|_| "Schlüsselbund-Operation fehlgeschlagen".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_never_expose_provider_data() {
        assert_eq!(error_message(&keyring::Error::NoDefaultStore), UNAVAILABLE);
        assert_eq!(
            error_message(&keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("private")
            ))),
            UNAVAILABLE
        );
        for error in [
            keyring::Error::BadEncoding(b"private".to_vec()),
            keyring::Error::Invalid("private".into(), "private".into()),
            keyring::Error::NoEntry,
        ] {
            assert_eq!(
                error_message(&error),
                "Schlüsselbund-Operation fehlgeschlagen"
            );
        }
    }
}
