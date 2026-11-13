//! Update check and self-update through `tauri-plugin-updater`, driven only from Rust.
//!
//! Network access happens solely in `update_check` and `update_install`, i.e. after a user
//! action in the frontend. `update_info` and plugin registration stay offline.
//! Self-update is limited to AppImage, NSIS and MSI; .deb/.rpm installs are updated by the
//! package manager (APT repository), so they only get the version information.

use serde::Serialize;
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Url, ipc::Channel, utils::config::BundleType};
use tauri_plugin_updater::{Error as UpdaterError, RemoteRelease, UpdaterExt};

/// Value shipped in tauri.conf.json until the real minisign public key exists.
pub const PUBKEY_PLACEHOLDER: &str = "WERKTERM_UPDATER_PUBKEY_PLACEHOLDER";
const STABLE_ENDPOINT: &str = "https://pkg.werklade.de/werkterm/updates/latest.json";
const TEST_ENDPOINT: &str = "https://pkg.werklade.de/werkterm/updates-test/latest.json";
const CHANNEL_ENV: &str = "WERKTERM_UPDATE_CHANNEL";
/// Total time limit of the manifest request; also the connect timeout of the download.
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// The download has no total limit (size varies); a stalled connection fails after this.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;
const MAX_NOTES_CHARS: usize = 10_000;
const PROGRESS_STEP: u64 = 256 * 1024;

const MSG_NO_KEY: &str = "Update-Schlüssel fehlt in diesem Build";
const MSG_PACKAGE_MANAGED: &str = "Diese Installation wird über die Paketverwaltung aktualisiert";
const MSG_RUNNING: &str = "Ein Update läuft bereits";
const MSG_NONE: &str = "Kein Update verfügbar";
const MSG_NO_PACKAGE: &str = "Update enthält kein Paket für diese Installationsart";
const MSG_INSTALL: &str = "Update konnte nicht installiert werden";
const MSG_INVALID_DATA: &str = "Update-Daten sind ungültig";
const MSG_NOT_WRITABLE: &str = "Der Ordner des AppImage ist nicht beschreibbar";
/// Exact error string: the shutdown hook already ran, so the frontend must force a restart.
pub const RESTART_REQUIRED: &str = "UPDATE_RESTART_REQUIRED";
/// The only host packages may be downloaded from.
const PACKAGE_HOST: &str = "pkg.werklade.de";

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Set by the Windows pre-exit hook once sessions, logs and the editor cache are shut down.
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    AppImage,
    Deb,
    Rpm,
    Nsis,
    Msi,
    /// cargo run / tauri dev, macOS or an unknown bundle.
    Other,
}

impl InstallKind {
    pub fn from_bundle(bundle: Option<BundleType>) -> Self {
        match bundle {
            Some(BundleType::AppImage) => Self::AppImage,
            Some(BundleType::Deb) => Self::Deb,
            Some(BundleType::Rpm) => Self::Rpm,
            Some(BundleType::Nsis) => Self::Nsis,
            Some(BundleType::Msi) => Self::Msi,
            _ => Self::Other,
        }
    }

    /// Reads the bundle type the Tauri bundler patched into this binary.
    pub fn current() -> Self {
        Self::from_bundle(tauri::utils::platform::bundle_type())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppImage => "appimage",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::Nsis => "nsis",
            Self::Msi => "msi",
            Self::Other => "other",
        }
    }

    /// Only these kinds may download and install an update themselves.
    pub fn self_update(self) -> bool {
        matches!(self, Self::AppImage | Self::Nsis | Self::Msi)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Test,
}

impl UpdateChannel {
    /// `WERKTERM_UPDATE_CHANNEL=test` selects the test channel; anything else is stable.
    pub fn from_env_value(value: Option<&str>) -> Self {
        match value {
            Some(v) if v.trim().eq_ignore_ascii_case("test") => Self::Test,
            _ => Self::Stable,
        }
    }

    pub fn current() -> Self {
        Self::from_env_value(std::env::var(CHANNEL_ENV).ok().as_deref())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Test => "test",
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_ENDPOINT,
            Self::Test => TEST_ENDPOINT,
        }
    }
}

/// False for an empty key or the placeholder shipped before the real key exists.
pub fn pubkey_configured(pubkey: &str) -> bool {
    let key = pubkey.trim();
    !key.is_empty() && !key.contains(PUBKEY_PLACEHOLDER)
}

fn configured_pubkey(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Same names the plugin uses for `{os}-{arch}`.
fn updater_os(os: &str) -> Option<&'static str> {
    match os {
        "linux" => Some("linux"),
        "windows" => Some("windows"),
        "macos" => Some("darwin"),
        _ => None,
    }
}

fn updater_arch(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("x86_64"),
        "aarch64" => Some("aarch64"),
        "x86" => Some("i686"),
        "arm" => Some("armv7"),
        "riscv64" => Some("riscv64"),
        _ => None,
    }
}

/// Manifest key `{os}-{arch}-{installer}` for self-updating kinds. There is deliberately no
/// fallback to `{os}-{arch}`, so an NSIS install never picks up an MSI or the other way round.
pub fn target_key(kind: InstallKind, os: &str, arch: &str) -> Option<String> {
    if !kind.self_update() {
        return None;
    }
    Some(format!(
        "{}-{}-{}",
        updater_os(os)?,
        updater_arch(arch)?,
        kind.as_str()
    ))
}

/// Redirects stay on https and on the host and port of the original request.
pub fn redirect_allowed(first: &Url, next: &Url, visited: usize) -> bool {
    visited <= MAX_REDIRECTS
        && next.scheme() == "https"
        && next.host_str().is_some()
        && next.host_str() == first.host_str()
        && next.port_or_known_default() == first.port_or_known_default()
}

fn client_policy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .https_only(true)
        .connect_timeout(CHECK_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.previous().first().is_some_and(|first| {
                redirect_allowed(first, attempt.url(), attempt.previous().len())
            });
            if allowed {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
}

fn limit_notes(notes: Option<String>) -> Option<String> {
    notes.map(|text| {
        if text.chars().count() > MAX_NOTES_CHARS {
            text.chars().take(MAX_NOTES_CHARS).collect()
        } else {
            text
        }
    })
}

/// User-facing message; never contains paths, URLs from the manifest or key material.
fn message(error: &UpdaterError) -> String {
    match error {
        UpdaterError::Reqwest(e) if e.is_timeout() => "Update-Server antwortet nicht (Zeitlimit)",
        UpdaterError::Reqwest(e) if e.is_decode() => MSG_INVALID_DATA,
        UpdaterError::Reqwest(_) => "Update-Server nicht erreichbar",
        UpdaterError::ReleaseNotFound => "Update-Server liefert keine gültigen Update-Daten",
        UpdaterError::Serialization(_) | UpdaterError::Semver(_) => MSG_INVALID_DATA,
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => MSG_NO_PACKAGE,
        UpdaterError::Network(_) => "Download des Updates fehlgeschlagen",
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => "Signatur des Updates ist ungültig",
        UpdaterError::InvalidUpdaterFormat | UpdaterError::BinaryNotFoundInArchive => {
            "Update-Paket hat ein unerwartetes Format"
        }
        UpdaterError::TempDirNotFound | UpdaterError::TempDirNotOnSameMountPoint => {
            "Kein geeigneter temporärer Ordner für das Update"
        }
        UpdaterError::PreviousAppNotRestored(_) => {
            "Update fehlgeschlagen, die bisherige Version liegt als Sicherung neben der App"
        }
        UpdaterError::UnsupportedArch | UpdaterError::UnsupportedOs => {
            "Diese Plattform wird vom Updater nicht unterstützt"
        }
        _ => "Update fehlgeschlagen",
    }
    .to_owned()
}

/// Message for a failed install. AppImage permission errors get the "not writable" text; once
/// the shutdown hook ran (Windows), the app is half shut down and only a restart helps.
fn install_message(error: &UpdaterError, kind: InstallKind, shutdown_started: bool) -> String {
    if shutdown_started {
        return RESTART_REQUIRED.to_owned();
    }
    if kind == InstallKind::AppImage
        && let UpdaterError::Io(io) = error
        && matches!(
            io.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem
        )
    {
        return MSG_NOT_WRITABLE.to_owned();
    }
    message(error)
}

/// Package URL from the manifest: https, exactly `pkg.werklade.de` on the default port, no
/// userinfo, and a file name that matches the install kind.
pub fn package_url_allowed(url: &Url, kind: InstallKind) -> bool {
    let suffix = match kind {
        InstallKind::Nsis => "-setup.exe",
        InstallKind::Msi => ".msi",
        InstallKind::AppImage => ".AppImage",
        InstallKind::Deb | InstallKind::Rpm | InstallKind::Other => return false,
    };
    let file = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    url.scheme() == "https"
        && url.host_str() == Some(PACKAGE_HOST)
        && url.port().is_none_or(|port| port == 443)
        && url.username().is_empty()
        && url.password().is_none()
        && file.len() > suffix.len()
        && file.ends_with(suffix)
}

/// True when the path can be written (access(2), which also reports read-only mounts).
/// No network, nothing is changed.
#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: c_path is a valid NUL-terminated string that lives for the call.
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn writable(_path: &Path) -> bool {
    false
}

/// The plugin swaps the AppImage file in place: both the file and its folder must be writable.
fn appimage_replaceable(appimage: Option<&Path>) -> bool {
    appimage
        .is_some_and(|file| file.is_file() && file.parent().is_some_and(writable) && writable(file))
}

/// $APPIMAGE as read by Tauri; the plugin installs to the same path.
fn appimage_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        app.env().appimage.map(std::path::PathBuf::from)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        None
    }
}

/// Why this installation cannot update itself, or None when it can.
/// `appimage_ok` is only consulted for AppImage installs.
fn install_block(kind: InstallKind, appimage_ok: bool) -> Option<&'static str> {
    match kind {
        InstallKind::Nsis | InstallKind::Msi => None,
        InstallKind::AppImage if appimage_ok => None,
        InstallKind::AppImage => Some(MSG_NOT_WRITABLE),
        InstallKind::Deb | InstallKind::Rpm | InstallKind::Other => Some(MSG_PACKAGE_MANAGED),
    }
}

fn current_block(app: &AppHandle, kind: InstallKind) -> Option<&'static str> {
    let appimage_ok =
        kind == InstallKind::AppImage && appimage_replaceable(appimage_path(app).as_deref());
    install_block(kind, appimage_ok)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Announced {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    newer: bool,
}

fn announced(release: &RemoteRelease, newer: bool) -> Announced {
    Announced {
        version: release.version.to_string(),
        notes: limit_notes(release.notes.clone()),
        pub_date: release.pub_date.and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        }),
        newer,
    }
}

type Seen = Arc<Mutex<Option<Announced>>>;

fn build_updater(
    app: &AppHandle,
    kind: InstallKind,
    seen: Seen,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint: Url = UpdateChannel::current()
        .endpoint()
        .parse()
        .map_err(|_| "Update-Adresse ist ungültig".to_owned())?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| message(&e))?
        .timeout(CHECK_TIMEOUT)
        .configure_client(client_policy)
        // Records what the server announced, so deb/rpm/other can report a newer version
        // even when the manifest has no package for them.
        .version_comparator(move |current, release| {
            let newer = release.version > current;
            if let Ok(mut slot) = seen.lock() {
                *slot = Some(announced(&release, newer));
            }
            newer
        });
    if let Some(target) = target_key(kind, std::env::consts::OS, std::env::consts::ARCH) {
        builder = builder.target(target);
    }
    #[cfg(windows)]
    {
        // The installer is started and this process ends with std::process::exit(0), which
        // skips RunEvent::Exit; run the same shutdown first (tunnels, logs, editor cache).
        let handle = app.clone();
        builder = builder.on_before_exit(move || {
            SHUTDOWN_STARTED.store(true, Ordering::Release);
            crate::shutdown(&handle);
            handle.cleanup_before_exit();
        });
    }
    builder.build().map_err(|e| message(&e))
}

fn require_key(app: &AppHandle) -> Result<(), String> {
    if pubkey_configured(&configured_pubkey(app)) {
        Ok(())
    } else {
        Err(MSG_NO_KEY.to_owned())
    }
}

/// Clears the running flag when the install command ends, also on errors.
struct RunGuard;

impl RunGuard {
    fn acquire() -> Option<Self> {
        RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    install_kind: &'static str,
    self_update: bool,
    channel: &'static str,
    configured: bool,
    can_install: bool,
    blocked_reason: Option<&'static str>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
}

impl CheckResult {
    fn none() -> Self {
        Self {
            available: false,
            version: None,
            notes: None,
            pub_date: None,
        }
    }
}

impl From<Announced> for CheckResult {
    fn from(seen: Announced) -> Self {
        Self {
            available: seen.newer,
            version: Some(seen.version),
            notes: seen.notes,
            pub_date: seen.pub_date,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum InstallEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Done { done: bool },
}

/// Offline: version, install kind, channel and whether this build carries an update key.
#[tauri::command]
pub fn update_info(app: AppHandle) -> UpdateInfo {
    let kind = InstallKind::current();
    let blocked = current_block(&app, kind);
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        install_kind: kind.as_str(),
        self_update: kind.self_update(),
        channel: UpdateChannel::current().as_str(),
        configured: pubkey_configured(&configured_pubkey(&app)),
        can_install: blocked.is_none(),
        blocked_reason: blocked,
    }
}

/// Fetches the manifest of the selected channel. Never downloads a package.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<CheckResult, String> {
    require_key(&app)?;
    let kind = InstallKind::current();
    let seen: Seen = Arc::default();
    let updater = build_updater(&app, kind, seen.clone())?;
    let result = updater.check().await;
    let seen = seen.lock().ok().and_then(|mut slot| slot.take());
    match result {
        Ok(_) => Ok(seen
            .map(CheckResult::from)
            .unwrap_or_else(CheckResult::none)),
        // deb/rpm/other only need the version; a missing package entry does not matter.
        Err(UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_))
            if !kind.self_update() =>
        {
            Ok(seen
                .map(CheckResult::from)
                .unwrap_or_else(CheckResult::none))
        }
        Err(error) => Err(message(&error)),
    }
}

/// Downloads, verifies and installs the update for AppImage/NSIS/MSI. Does not restart:
/// on Linux the frontend calls `app_restart` afterwards; on Windows the installer ends this
/// process and starts the new version itself, so this command never returns there on success.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    on_progress: Channel<InstallEvent>,
) -> Result<(), String> {
    let kind = InstallKind::current();
    // Same local checks as update_info, before any network access.
    if let Some(reason) = current_block(&app, kind) {
        return Err(reason.to_owned());
    }
    require_key(&app)?;
    let _guard = RunGuard::acquire().ok_or_else(|| MSG_RUNNING.to_owned())?;
    let updater = build_updater(&app, kind, Arc::default())?;
    let update = updater
        .check()
        .await
        .map_err(|e| message(&e))?
        .ok_or_else(|| MSG_NONE.to_owned())?;
    if !package_url_allowed(&update.download_url, kind) {
        return Err(MSG_INVALID_DATA.to_owned());
    }

    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = on_progress.send(InstallEvent::Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| message(&e))?;
    let total = Some(bytes.len() as u64);
    let _ = on_progress.send(InstallEvent::Progress {
        downloaded: bytes.len() as u64,
        total,
    });

    // Blocking thread: the AppImage swap does file I/O, and the Windows shutdown hook uses
    // block_on, which must not run on an async worker.
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    let shutdown_started = SHUTDOWN_STARTED.load(Ordering::Acquire);
    match installed {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(install_message(&error, kind, shutdown_started)),
        Err(_) if shutdown_started => return Err(RESTART_REQUIRED.to_owned()),
        Err(_) => return Err(MSG_INSTALL.to_owned()),
    }
    let _ = on_progress.send(InstallEvent::Done { done: true });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_bundle_types_to_install_kinds() {
        let cases = [
            (Some(BundleType::AppImage), "appimage", true),
            (Some(BundleType::Nsis), "nsis", true),
            (Some(BundleType::Msi), "msi", true),
            (Some(BundleType::Deb), "deb", false),
            (Some(BundleType::Rpm), "rpm", false),
            (Some(BundleType::App), "other", false),
            (Some(BundleType::Dmg), "other", false),
            (None, "other", false),
        ];
        for (bundle, name, self_update) in cases {
            let kind = InstallKind::from_bundle(bundle);
            assert_eq!(kind.as_str(), name);
            assert_eq!(kind.self_update(), self_update, "{name}");
        }
    }

    #[test]
    fn unit_test_binary_is_not_a_bundle() {
        assert_eq!(InstallKind::current(), InstallKind::Other);
    }

    #[test]
    fn selects_channel_only_for_test() {
        assert_eq!(UpdateChannel::from_env_value(None), UpdateChannel::Stable);
        assert_eq!(
            UpdateChannel::from_env_value(Some("")),
            UpdateChannel::Stable
        );
        assert_eq!(
            UpdateChannel::from_env_value(Some("beta")),
            UpdateChannel::Stable
        );
        assert_eq!(
            UpdateChannel::from_env_value(Some("https://example.org/x.json")),
            UpdateChannel::Stable
        );
        assert_eq!(
            UpdateChannel::from_env_value(Some("test")),
            UpdateChannel::Test
        );
        assert_eq!(
            UpdateChannel::from_env_value(Some(" TEST ")),
            UpdateChannel::Test
        );
        assert_eq!(UpdateChannel::Stable.endpoint(), STABLE_ENDPOINT);
        assert_eq!(UpdateChannel::Test.endpoint(), TEST_ENDPOINT);
        assert_eq!(UpdateChannel::Test.as_str(), "test");
        for channel in [UpdateChannel::Stable, UpdateChannel::Test] {
            let url: Url = channel.endpoint().parse().unwrap();
            assert_eq!(url.scheme(), "https");
            assert_eq!(url.host_str(), Some("pkg.werklade.de"));
        }
    }

    #[test]
    fn detects_placeholder_key() {
        assert!(!pubkey_configured(PUBKEY_PLACEHOLDER));
        assert!(!pubkey_configured(&format!(" {PUBKEY_PLACEHOLDER} ")));
        assert!(!pubkey_configured(""));
        assert!(!pubkey_configured("   "));
        assert!(pubkey_configured(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="
        ));
    }

    #[test]
    fn shipped_config_uses_the_placeholder_or_a_real_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert!(updater["pubkey"].is_string());
        assert_eq!(updater["windows"]["installMode"], "passive");
        // Signatures must bind the version, so a forged manifest cannot downgrade.
        assert_eq!(updater["requireSignedVersion"], true);
        assert!(
            updater.get("endpoints").is_none(),
            "endpoints are fixed in updater.rs"
        );
        assert!(config["bundle"].get("createUpdaterArtifacts").is_none());
    }

    #[test]
    fn builds_target_keys_per_install_kind() {
        let key = |kind, os, arch| target_key(kind, os, arch);
        assert_eq!(
            key(InstallKind::AppImage, "linux", "x86_64").as_deref(),
            Some("linux-x86_64-appimage")
        );
        assert_eq!(
            key(InstallKind::Nsis, "windows", "x86_64").as_deref(),
            Some("windows-x86_64-nsis")
        );
        assert_eq!(
            key(InstallKind::Msi, "windows", "aarch64").as_deref(),
            Some("windows-aarch64-msi")
        );
        assert_eq!(key(InstallKind::Deb, "linux", "x86_64"), None);
        assert_eq!(key(InstallKind::Rpm, "linux", "x86_64"), None);
        assert_eq!(key(InstallKind::Other, "linux", "x86_64"), None);
        assert_eq!(key(InstallKind::AppImage, "freebsd", "x86_64"), None);
        assert_eq!(key(InstallKind::Nsis, "windows", "mips"), None);
    }

    #[test]
    fn allows_redirects_only_on_the_same_https_host() {
        let first: Url = STABLE_ENDPOINT.parse().unwrap();
        let url = |s: &str| s.parse::<Url>().unwrap();
        assert!(redirect_allowed(
            &first,
            &url("https://pkg.werklade.de/other.json"),
            1
        ));
        assert!(redirect_allowed(
            &first,
            &url("https://pkg.werklade.de:443/a"),
            1
        ));
        assert!(!redirect_allowed(
            &first,
            &url("http://pkg.werklade.de/a"),
            1
        ));
        assert!(!redirect_allowed(&first, &url("https://evil.example/a"), 1));
        assert!(!redirect_allowed(
            &first,
            &url("https://sub.pkg.werklade.de/a"),
            1
        ));
        assert!(!redirect_allowed(
            &first,
            &url("https://pkg.werklade.de:8443/a"),
            1
        ));
        assert!(!redirect_allowed(
            &first,
            &url("https://pkg.werklade.de/a"),
            MAX_REDIRECTS + 1
        ));
    }

    #[test]
    fn limits_release_notes() {
        let long = "ä".repeat(MAX_NOTES_CHARS + 5);
        assert_eq!(
            limit_notes(Some(long)).unwrap().chars().count(),
            MAX_NOTES_CHARS
        );
        assert_eq!(limit_notes(Some("kurz".into())).as_deref(), Some("kurz"));
        assert_eq!(limit_notes(None), None);
    }

    #[test]
    fn reports_announced_version_for_package_managed_installs() {
        let seen = Announced {
            version: "0.2.0".into(),
            notes: Some("Neu".into()),
            pub_date: Some("2026-11-13T10:00:00Z".into()),
            newer: true,
        };
        let result = CheckResult::from(seen.clone());
        assert!(result.available);
        assert_eq!(result.version.as_deref(), Some("0.2.0"));
        let older = CheckResult::from(Announced {
            newer: false,
            ..seen
        });
        assert!(!older.available);
        assert_eq!(CheckResult::none().version, None);
    }

    #[test]
    fn serializes_the_ipc_contract() {
        let check = serde_json::to_value(CheckResult {
            available: true,
            version: Some("0.2.0".into()),
            notes: None,
            pub_date: Some("2026-11-13T10:00:00Z".into()),
        })
        .unwrap();
        assert_eq!(
            check,
            serde_json::json!({"available": true, "version": "0.2.0", "notes": null, "pubDate": "2026-11-13T10:00:00Z"})
        );
        let info = serde_json::to_value(UpdateInfo {
            current_version: "0.1.8".into(),
            install_kind: "deb",
            self_update: false,
            channel: "stable",
            configured: false,
            can_install: false,
            blocked_reason: Some(MSG_PACKAGE_MANAGED),
        })
        .unwrap();
        assert_eq!(
            info,
            serde_json::json!({
                "currentVersion": "0.1.8",
                "installKind": "deb",
                "selfUpdate": false,
                "channel": "stable",
                "configured": false,
                "canInstall": false,
                "blockedReason": MSG_PACKAGE_MANAGED
            })
        );
        assert_eq!(
            serde_json::to_value(InstallEvent::Progress {
                downloaded: 5,
                total: None
            })
            .unwrap(),
            serde_json::json!({"downloaded": 5, "total": null})
        );
        assert_eq!(
            serde_json::to_value(InstallEvent::Done { done: true }).unwrap(),
            serde_json::json!({"done": true})
        );
    }

    #[test]
    fn messages_do_not_leak_paths() {
        let path = std::path::PathBuf::from("secret-dir").join("werkterm.AppImage");
        let text = message(&UpdaterError::PreviousAppNotRestored(path));
        assert!(!text.contains("secret-dir"));
        assert_eq!(
            message(&UpdaterError::TargetsNotFound(vec!["linux-x86_64".into()])),
            MSG_NO_PACKAGE
        );
    }

    #[test]
    fn allows_only_one_install_at_a_time() {
        let first = RunGuard::acquire().expect("first run");
        assert!(RunGuard::acquire().is_none());
        drop(first);
        assert!(RunGuard::acquire().is_some());
    }

    #[test]
    fn reports_restart_required_once_the_shutdown_hook_ran() {
        let failed = || UpdaterError::Io(std::io::Error::other("ShellExecuteW failed"));
        assert_eq!(
            install_message(&failed(), InstallKind::Nsis, true),
            RESTART_REQUIRED
        );
        assert_eq!(
            install_message(&failed(), InstallKind::Msi, true),
            RESTART_REQUIRED
        );
        assert_eq!(
            install_message(&UpdaterError::InvalidUpdaterFormat, InstallKind::Nsis, true),
            RESTART_REQUIRED
        );
        assert_ne!(
            install_message(&failed(), InstallKind::Nsis, false),
            RESTART_REQUIRED
        );
        assert_eq!(RESTART_REQUIRED, "UPDATE_RESTART_REQUIRED");
    }

    #[test]
    fn maps_appimage_permission_errors_to_not_writable() {
        for io_kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::ReadOnlyFilesystem,
        ] {
            let error = UpdaterError::Io(std::io::Error::from(io_kind));
            assert_eq!(
                install_message(&error, InstallKind::AppImage, false),
                MSG_NOT_WRITABLE
            );
            assert_ne!(
                install_message(&error, InstallKind::Nsis, false),
                MSG_NOT_WRITABLE
            );
        }
        let other = UpdaterError::Io(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_ne!(
            install_message(&other, InstallKind::AppImage, false),
            MSG_NOT_WRITABLE
        );
    }

    #[test]
    fn accepts_package_urls_only_from_the_package_host() {
        let ok = |s: &str, kind| package_url_allowed(&s.parse::<Url>().unwrap(), kind);
        let base = "https://pkg.werklade.de/werkterm/0.2.0";
        assert!(ok(
            &format!("{base}/Werkterm_0.2.0_x64-setup.exe"),
            InstallKind::Nsis
        ));
        assert!(ok(
            &format!("{base}/Werkterm_0.2.0_x64_en-US.msi"),
            InstallKind::Msi
        ));
        assert!(ok(
            &format!("{base}/Werkterm_0.2.0_amd64.AppImage"),
            InstallKind::AppImage
        ));
        assert!(ok(
            "https://pkg.werklade.de:443/w/W-setup.exe",
            InstallKind::Nsis
        ));
        assert!(ok(
            "https://PKG.werklade.de/w/W-setup.exe",
            InstallKind::Nsis
        ));
        for bad in [
            "http://pkg.werklade.de/w/W-setup.exe",
            "https://evil.example/w/W-setup.exe",
            "https://pkg.werklade.de.example.org/w/W-setup.exe",
            "https://sub.pkg.werklade.de/w/W-setup.exe",
            "https://xpkg.werklade.de/w/W-setup.exe",
            "https://pkg.werklade.de./w/W-setup.exe",
            "https://pkg.werklade.de@evil.example/w/W-setup.exe",
            "https://user@pkg.werklade.de/w/W-setup.exe",
            "https://user:pw@pkg.werklade.de/w/W-setup.exe",
            "https://pkg.werklade.de:8443/w/W-setup.exe",
            "https://pkg.werklade.de:80/w/W-setup.exe",
            "https://203.0.113.7/w/W-setup.exe",
        ] {
            assert!(!ok(bad, InstallKind::Nsis), "{bad}");
        }
    }

    #[test]
    fn requires_a_file_name_matching_the_install_kind() {
        let ok = |s: &str, kind| package_url_allowed(&s.parse::<Url>().unwrap(), kind);
        let url = |file: &str| format!("https://pkg.werklade.de/werkterm/{file}");
        assert!(!ok(&url("W_x64.msi"), InstallKind::Nsis));
        assert!(!ok(&url("W.exe"), InstallKind::Nsis));
        assert!(!ok(&url("W-setup.exe"), InstallKind::Msi));
        assert!(!ok(&url("W.AppImage.tar.gz"), InstallKind::AppImage));
        assert!(!ok(&url("W.appimage"), InstallKind::AppImage));
        assert!(!ok(&url("W_amd64.deb"), InstallKind::AppImage));
        assert!(!ok(&url("-setup.exe"), InstallKind::Nsis));
        assert!(!ok(
            "https://pkg.werklade.de/W-setup.exe/",
            InstallKind::Nsis
        ));
        for kind in [InstallKind::Deb, InstallKind::Rpm, InstallKind::Other] {
            assert!(!ok(&url("W.AppImage"), kind));
        }
    }

    #[test]
    fn blocks_install_by_kind_and_appimage_writability() {
        assert_eq!(install_block(InstallKind::Nsis, false), None);
        assert_eq!(install_block(InstallKind::Msi, false), None);
        assert_eq!(install_block(InstallKind::AppImage, true), None);
        assert_eq!(
            install_block(InstallKind::AppImage, false),
            Some(MSG_NOT_WRITABLE)
        );
        for kind in [InstallKind::Deb, InstallKind::Rpm, InstallKind::Other] {
            assert_eq!(install_block(kind, true), Some(MSG_PACKAGE_MANAGED));
        }
        assert!(!appimage_replaceable(None));
    }

    #[cfg(unix)]
    #[test]
    fn checks_appimage_file_and_folder_writability() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("werkterm-updater-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Werkterm.AppImage");
        std::fs::write(&file, b"x").unwrap();
        assert!(appimage_replaceable(Some(&file)));
        assert!(!appimage_replaceable(Some(&dir.join("missing.AppImage"))));
        assert!(!appimage_replaceable(Some(&dir)));
        // root ignores permission bits; these checks only apply to normal users.
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            assert!(!appimage_replaceable(Some(&file)));
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o444)).unwrap();
            assert!(!appimage_replaceable(Some(&file)));
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
