//! OS-backed secrets. Never return provider text (which may contain secrets).
use std::hash::BuildHasher;

const SERVICE: &str = "de.werklade.werkterm";
const LEGACY_SERVICE: &str = "de.marck.linmoba";
const FAILED: &str = "KEYRING_FAILED: Schlüsselbund-Operation fehlgeschlagen";
const UNAVAILABLE: &str = "KEYRING_UNAVAILABLE: Kein Secret Service oder D-Bus verfügbar";
static PROBE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// keyring 4.2's v1 facade reexports keyring-core::Error, but not the concrete
// Secret Service error type. Match only exact, fixed Display strings verified in
// secret-service 5.2.0/src/error.rs, never substrings or arbitrary D-Bus messages.
// zbus-secret-service-keyring-store 1.0.1 wraps these errors unchanged.
fn provider_message(message: &str, writing_default: bool) -> &'static str {
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
        return UNAVAILABLE;
    }
    match message {
        "SS Error: object locked" | "SS error: prompt dismissed" => {
            "KEYRING_LOCKED: Schlüsselbund ist gesperrt"
        }
        // In this store's set_secret path, NoResult only comes from resolving
        // the default collection alias. For reads/deletes its meaning is unknown.
        "SS error: result not returned from SS API" if writing_default => {
            "KEYRING_NO_COLLECTION: Kein Standard-Schlüsselbund vorhanden"
        }
        "no secret service provider or dbus session found" => UNAVAILABLE,
        _ => FAILED,
    }
}

fn categorized_error(error: &keyring::Error, writing_default: bool) -> String {
    match error {
        keyring::Error::NoDefaultStore => UNAVAILABLE.into(),
        keyring::Error::PlatformFailure(source) | keyring::Error::NoStorageAccess(source)
            if cfg!(target_os = "linux") =>
        {
            provider_message(&source.to_string(), writing_default).into()
        }
        _ => FAILED.into(),
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
    let _guard = PROBE_LOCK.lock().map_err(|_| FAILED.to_owned())?;
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
                Err(FAILED.into())
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
        .map_err(|_| FAILED.to_owned())?
}

pub async fn set_password(account: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(SERVICE, &account)
            .and_then(|entry| entry.set_password(&password))
            .map_err(|error| operation_error(&error, true))
    })
    .await
    .map_err(|_| FAILED.to_owned())?
}

trait SecretStore {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn write(&self, service: &str, account: &str, password: &str) -> Result<(), String>;
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
    fn write(&self, service: &str, account: &str, password: &str) -> Result<(), String> {
        keyring::Entry::new(service, account)
            .and_then(|entry| entry.set_password(password))
            .map_err(|error| operation_error(&error, true))
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match keyring::Entry::new(service, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(operation_error(&error, false)),
        }
    }
}

fn read_migrating(store: &impl SecretStore, account: &str) -> Result<Option<String>, String> {
    if let Some(password) = store.read(SERVICE, account)? {
        return Ok(Some(password));
    }
    let password = store.read(LEGACY_SERVICE, account)?;
    if let Some(value) = &password
        && store.write(SERVICE, account, value).is_ok()
    {
        let _ = store.delete(LEGACY_SERVICE, account);
    }
    Ok(password)
}

fn cleanup_result(result: Result<(), String>) -> Result<(), String> {
    match result {
        Err(error)
            if error.starts_with("KEYRING_UNAVAILABLE:")
                || error.starts_with("KEYRING_NO_COLLECTION:") =>
        {
            Ok(())
        }
        other => other,
    }
}

fn delete_both(store: &impl SecretStore, account: &str) -> Result<(), String> {
    let current = store.delete(SERVICE, account);
    let legacy = store.delete(LEGACY_SERVICE, account);
    cleanup_result(current).and(cleanup_result(legacy))
}

pub async fn get_password(account: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_migrating(&OsStore, &account))
        .await
        .map_err(|_| FAILED.to_owned())?
}

pub async fn delete_password(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_both(&OsStore, &account))
        .await
        .map_err(|_| FAILED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn categorizes_verified_provider_errors_without_exposing_data() {
        for message in ["SS Error: object locked", "SS error: prompt dismissed"] {
            assert_eq!(
                provider_message(message, false),
                "KEYRING_LOCKED: Schlüsselbund ist gesperrt"
            );
        }
        let no_result = "SS error: result not returned from SS API";
        assert_eq!(
            provider_message(no_result, true),
            "KEYRING_NO_COLLECTION: Kein Standard-Schlüsselbund vorhanden"
        );
        assert_eq!(provider_message(no_result, false), FAILED);
        assert_eq!(
            provider_message("no secret service provider or dbus session found", false),
            UNAVAILABLE
        );
        for name in ["ServiceUnknown", "NameHasNoOwner", "Disconnected"] {
            let message = format!("zbus error: org.freedesktop.DBus.Error.{name}: private details");
            assert_eq!(provider_message(&message, false), UNAVAILABLE);
        }
        for message in [
            "private",
            "private: SS Error: object locked",
            "SS error: connection closed before prompt completed",
        ] {
            assert_eq!(provider_message(message, true), FAILED);
        }
    }

    #[test]
    fn cleanup_ignores_only_unavailable_store_and_no_collection() {
        for error in [
            UNAVAILABLE,
            "KEYRING_NO_COLLECTION: Kein Standard-Schlüsselbund vorhanden",
        ] {
            assert!(cleanup_result(Err(error.into())).is_ok());
        }
        for error in [FAILED, "KEYRING_LOCKED: Schlüsselbund ist gesperrt"] {
            assert_eq!(cleanup_result(Err(error.into())), Err(error.into()));
        }
    }

    #[test]
    fn errors_never_expose_provider_data() {
        assert_eq!(error_message(&keyring::Error::NoDefaultStore), UNAVAILABLE);
        for error in [
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("private"))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("private"))),
            keyring::Error::BadEncoding(b"private".to_vec()),
            keyring::Error::Invalid("private".into(), "private".into()),
            keyring::Error::NoEntry,
        ] {
            assert_eq!(error_message(&error), FAILED);
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
        fail_write: bool,
    }
    impl SecretStore for FakeStore {
        fn read(&self, service: &str, _: &str) -> Result<Option<String>, String> {
            Ok(self.entries.borrow().get(service).cloned())
        }
        fn write(&self, service: &str, _: &str, password: &str) -> Result<(), String> {
            if self.fail_write {
                return Err(FAILED.into());
            }
            self.entries
                .borrow_mut()
                .insert(service.into(), password.into());
            Ok(())
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
        fn write(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
            panic!("cleanup must not write secrets");
        }
        fn delete(&self, service: &str, _: &str) -> Result<(), String> {
            Err(if service == SERVICE {
                "KEYRING_NO_COLLECTION: Kein Standard-Schlüsselbund vorhanden".into()
            } else {
                UNAVAILABLE.into()
            })
        }
    }
    #[test]
    fn deletion_succeeds_without_collection_or_service() {
        assert!(delete_both(&UnavailableStore, "session").is_ok());
    }

    #[test]
    fn migrates_only_after_successful_write() {
        for fail_write in [false, true] {
            let store = FakeStore {
                fail_write,
                ..Default::default()
            };
            store
                .entries
                .borrow_mut()
                .insert(LEGACY_SERVICE.into(), "test-secret".into());
            assert_eq!(
                read_migrating(&store, "session").unwrap().as_deref(),
                Some("test-secret")
            );
            assert_eq!(
                store.entries.borrow().contains_key(LEGACY_SERVICE),
                fail_write
            );
            assert_eq!(store.entries.borrow().contains_key(SERVICE), !fail_write);
        }
    }
    #[test]
    fn missing_and_current_entries() {
        let store = FakeStore::default();
        assert_eq!(read_migrating(&store, "session").unwrap(), None);
        store
            .entries
            .borrow_mut()
            .insert(SERVICE.into(), "current".into());
        store
            .entries
            .borrow_mut()
            .insert(LEGACY_SERVICE.into(), "old".into());
        assert_eq!(
            read_migrating(&store, "session").unwrap().as_deref(),
            Some("current")
        );
        assert_eq!(store.entries.borrow().get(LEGACY_SERVICE).unwrap(), "old");
        delete_both(&store, "session").unwrap();
        assert!(store.entries.borrow().is_empty());
    }
}
