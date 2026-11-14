//! OS-backed secrets. Never return provider text (which may contain secrets).
use crate::ui_error::{UiError, code_of, ui_err};
use std::hash::BuildHasher;

const SERVICE: &str = "de.werklade.werkterm";
fn failed() -> UiError {
    ui_err("KEYRING_FAILED")
}
fn unavailable() -> UiError {
    ui_err("KEYRING_UNAVAILABLE")
}
fn locked() -> UiError {
    ui_err("KEYRING_LOCKED")
}
fn no_collection() -> UiError {
    ui_err("KEYRING_NO_COLLECTION")
}
static PROBE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// keyring 4.2's v1 facade reexports keyring-core::Error, but not the concrete
// Secret Service error type. Match only exact, fixed Display strings verified in
// secret-service 5.2.0/src/error.rs, never substrings or arbitrary D-Bus messages.
// zbus-secret-service-keyring-store 1.0.1 wraps these errors unchanged.
fn provider_message(message: &str, writing_default: bool) -> UiError {
    // zbus 5's MethodError Display starts with its typed error name followed
    // by ": ". Inspect only that name; never forward the arbitrary detail.
    if matches!(
        message
            .strip_prefix("zbus error: ")
            .and_then(|rest| rest.split_once(": ").map(|(name, _)| name)),
        Some(
            "org.freedesktop.DBus.Error.ServiceUnknown"
                | "org.freedesktop.DBus.Error.NameHasNoOwner"
                | "org.freedesktop.DBus.Error.Disconnected"
        )
    ) {
        return unavailable();
    }
    match message {
        "SS Error: object locked" | "SS error: prompt dismissed" => locked(),
        // In this store's set_secret path, NoResult only comes from resolving
        // the default collection alias. For reads/deletes its meaning is unknown.
        "SS error: result not returned from SS API" if writing_default => no_collection(),
        "no secret service provider or dbus session found" => unavailable(),
        _ => failed(),
    }
}

fn categorized_error(error: &keyring::Error, writing_default: bool) -> String {
    match error {
        keyring::Error::NoDefaultStore => unavailable().into(),
        keyring::Error::PlatformFailure(source) | keyring::Error::NoStorageAccess(source)
            if cfg!(target_os = "linux") =>
        {
            provider_message(&source.to_string(), writing_default).into()
        }
        _ => failed().into(),
    }
}

pub fn error_message(error: &keyring::Error) -> String {
    categorized_error(error, false)
}

fn operation_error(error: &keyring::Error, writing_default: bool) -> String {
    if matches!(error, keyring::Error::NoDefaultStore)
        && let Err(cause) = keyring::Entry::store_status()
    {
        return categorized_error(cause, writing_default);
    }
    categorized_error(error, writing_default)
}

fn live_available() -> Result<bool, String> {
    // The reserved account is shared by dialog probes; serialize write/read/delete.
    let _guard = PROBE_LOCK.lock().map_err(|_| String::from(failed()))?;
    keyring::Entry::store_status()
        .as_ref()
        .map_err(error_message)?;
    let readonly = keyring::Entry::new(SERVICE, "availability:readonly")
        .and_then(|entry| entry.get_password());
    match readonly {
        Ok(_) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(operation_error(&error, false)),
    }
    let entry = keyring::Entry::new(SERVICE, "availability:probe")
        .map_err(|error| operation_error(&error, false))?;
    // RandomState is randomly seeded by std. This disposable value is not a
    // credential and does not require a new crypto dependency.
    let value = format!(
        "{:016x}",
        std::collections::hash_map::RandomState::new().hash_one("probe")
    );
    let result = entry
        .set_password(&value)
        .map_err(|error| operation_error(&error, true))
        .and_then(|()| {
            entry
                .get_password()
                .map_err(|error| operation_error(&error, false))
        })
        .and_then(|read| {
            if read == value {
                Ok(true)
            } else {
                Err(failed().into())
            }
        });
    // Always attempt cleanup, even after a provider reports a failed write/read.
    let cleanup = match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(operation_error(&error, false)),
    };
    match (result, cleanup) {
        (Err(error), _) | (_, Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

/// Called only from a user-opened SessionDialog, never during app startup.
pub async fn available() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(live_available)
        .await
        .map_err(|_| String::from(failed()))?
}

pub async fn set_password(account: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(SERVICE, &account)
            .and_then(|entry| entry.set_password(&password))
            .map_err(|error| operation_error(&error, true))
    })
    .await
    .map_err(|_| String::from(failed()))?
}

trait SecretStore {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

struct OsStore;
impl SecretStore for OsStore {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(service, account).and_then(|entry| entry.get_password()) {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(operation_error(&error, false)),
        }
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match keyring::Entry::new(service, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(operation_error(&error, false)),
        }
    }
}

fn read_secret(store: &impl SecretStore, account: &str) -> Result<Option<String>, String> {
    store.read(SERVICE, account)
}

fn cleanup_result(result: Result<(), String>) -> Result<(), String> {
    match result {
        Err(error)
            if matches!(
                code_of(&error),
                Some("KEYRING_UNAVAILABLE" | "KEYRING_NO_COLLECTION")
            ) =>
        {
            Ok(())
        }
        other => other,
    }
}

fn delete_secret(store: &impl SecretStore, account: &str) -> Result<(), String> {
    cleanup_result(store.delete(SERVICE, account))
}

pub async fn get_password(account: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_secret(&OsStore, &account))
        .await
        .map_err(|_| String::from(failed()))?
}

pub async fn delete_password(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_secret(&OsStore, &account))
        .await
        .map_err(|_| String::from(failed()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn categorizes_verified_provider_errors_without_exposing_data() {
        for message in ["SS Error: object locked", "SS error: prompt dismissed"] {
            assert_eq!(provider_message(message, false), locked());
        }
        let no_result = "SS error: result not returned from SS API";
        assert_eq!(provider_message(no_result, true), no_collection());
        assert_eq!(provider_message(no_result, false), failed());
        assert_eq!(
            provider_message("no secret service provider or dbus session found", false),
            unavailable()
        );
        for name in ["ServiceUnknown", "NameHasNoOwner", "Disconnected"] {
            let message = format!("zbus error: org.freedesktop.DBus.Error.{name}: private details");
            assert_eq!(provider_message(&message, false), unavailable());
        }
        for message in [
            "private",
            "private: SS Error: object locked",
            "SS error: connection closed before prompt completed",
        ] {
            assert_eq!(provider_message(message, true), failed());
        }
    }

    #[test]
    fn cleanup_ignores_only_unavailable_store_and_no_collection() {
        for error in [unavailable(), no_collection()] {
            assert!(cleanup_result(Err(error.into())).is_ok());
        }
        for error in [failed(), locked()] {
            let error = String::from(error);
            assert_eq!(cleanup_result(Err(error.clone())), Err(error));
        }
    }

    #[test]
    fn errors_never_expose_provider_data() {
        assert_eq!(
            error_message(&keyring::Error::NoDefaultStore),
            String::from(unavailable())
        );
        for error in [
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("private"))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("private"))),
            keyring::Error::BadEncoding(b"private".to_vec()),
            keyring::Error::Invalid("private".into(), "private".into()),
            keyring::Error::NoEntry,
        ] {
            assert_eq!(error_message(&error), String::from(failed()));
        }
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    #[derive(Default)]
    struct FakeStore {
        entries: RefCell<HashMap<String, String>>,
    }
    impl SecretStore for FakeStore {
        fn read(&self, service: &str, _: &str) -> Result<Option<String>, String> {
            Ok(self.entries.borrow().get(service).cloned())
        }
        fn delete(&self, service: &str, _: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(service);
            Ok(())
        }
    }
    struct UnavailableStore;
    impl SecretStore for UnavailableStore {
        fn read(&self, _: &str, _: &str) -> Result<Option<String>, String> {
            panic!("cleanup must not read secrets");
        }
        fn delete(&self, service: &str, _: &str) -> Result<(), String> {
            Err(if service == SERVICE {
                no_collection().into()
            } else {
                unavailable().into()
            })
        }
    }
    #[test]
    fn deletion_succeeds_without_collection_or_service() {
        assert!(delete_secret(&UnavailableStore, "session").is_ok());
    }

    #[test]
    fn missing_and_current_entries() {
        let store = FakeStore::default();
        assert_eq!(read_secret(&store, "session").unwrap(), None);
        store
            .entries
            .borrow_mut()
            .insert(SERVICE.into(), "current".into());
        assert_eq!(
            read_secret(&store, "session").unwrap().as_deref(),
            Some("current")
        );
        delete_secret(&store, "session").unwrap();
        assert!(store.entries.borrow().is_empty());
    }
}
