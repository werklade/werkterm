//! Update check and self-update through `tauri-plugin-updater`, driven only from Rust.
//!
//! Network access happens solely in `update_check` and `update_install`, i.e. after a user
//! action in the frontend. `update_info` and plugin registration stay offline.
//! Self-update is limited to AppImage, NSIS and MSI; .deb/.rpm installs are updated by the
//! package manager (APT repository), so they only get the version information.
//!
//! Channel: WERKTERM_UPDATE_CHANNEL ("test"/"stable") wins over the per-device setting the
//! frontend passes in. The test channel reads the test and the stable manifest and offers the
//! newer release; the stable channel offers the stable release, also as a downgrade from a test
//! build (only with the user's confirmation in update_install).

use crate::ui_error::ui_code;
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

// Error codes; the frontend translates them via `error.<CODE>`.
const MSG_NO_KEY: &str = ui_code("UPDATE_NO_KEY");
const MSG_PACKAGE_MANAGED: &str = ui_code("UPDATE_PACKAGE_MANAGED");
const MSG_RUNNING: &str = ui_code("UPDATE_RUNNING");
const MSG_NONE: &str = ui_code("UPDATE_NONE");
const MSG_NO_PACKAGE: &str = ui_code("UPDATE_NO_PACKAGE");
const MSG_INSTALL: &str = ui_code("UPDATE_INSTALL_FAILED");
const MSG_INVALID_DATA: &str = ui_code("UPDATE_INVALID_DATA");
const MSG_NOT_WRITABLE: &str = ui_code("UPDATE_NOT_WRITABLE");
/// The offer found by the install differs from the one the user saw (other version).
const MSG_CHANGED: &str = ui_code("UPDATE_CHANGED");
/// A downgrade reached update_install without the user's confirmation.
const MSG_DOWNGRADE_UNCONFIRMED: &str = ui_code("UPDATE_DOWNGRADE_UNCONFIRMED");
/// Exact error string: the shutdown hook already ran, so the frontend must force a restart.
pub const RESTART_REQUIRED: &str = ui_code("UPDATE_RESTART_REQUIRED");
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
    /// "test" or "stable" (trimmed, any case); anything else is no channel.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.eq_ignore_ascii_case("test") {
            Some(Self::Test)
        } else if value.eq_ignore_ascii_case("stable") {
            Some(Self::Stable)
        } else {
            None
        }
    }

    /// The environment variable wins when it names a channel ("test" or "stable"); otherwise the
    /// per-device setting from the frontend; otherwise stable. The flag tells whether the
    /// environment decided.
    pub fn resolve(env: Option<&str>, setting: Option<&str>) -> (Self, bool) {
        if let Some(channel) = env.and_then(Self::parse) {
            return (channel, true);
        }
        (setting.and_then(Self::parse).unwrap_or(Self::Stable), false)
    }

    /// Effective channel for this process and the given setting.
    pub fn current(setting: Option<&str>) -> (Self, bool) {
        Self::resolve(std::env::var(CHANNEL_ENV).ok().as_deref(), setting)
    }

    /// Manifests that are fetched for this channel, in order of preference on equal versions.
    /// The test channel also reads the stable manifest, so a stable release newer than the
    /// last test build is offered there too.
    pub fn manifests(self) -> &'static [UpdateChannel] {
        match self {
            Self::Stable => &[Self::Stable],
            Self::Test => &[Self::Test, Self::Stable],
        }
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

/// User-facing error code; never contains paths, URLs from the manifest or key material.
fn message(error: &UpdaterError) -> String {
    match error {
        UpdaterError::Reqwest(e) if e.is_timeout() => ui_code("UPDATE_TIMEOUT"),
        UpdaterError::Reqwest(e) if e.is_decode() => MSG_INVALID_DATA,
        UpdaterError::Reqwest(_) => ui_code("UPDATE_UNREACHABLE"),
        UpdaterError::ReleaseNotFound => ui_code("UPDATE_NO_RELEASE"),
        UpdaterError::Serialization(_) | UpdaterError::Semver(_) => MSG_INVALID_DATA,
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => MSG_NO_PACKAGE,
        UpdaterError::Network(_) => ui_code("UPDATE_DOWNLOAD_FAILED"),
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => ui_code("UPDATE_SIGNATURE"),
        UpdaterError::InvalidUpdaterFormat | UpdaterError::BinaryNotFoundInArchive => {
            ui_code("UPDATE_FORMAT")
        }
        UpdaterError::TempDirNotFound | UpdaterError::TempDirNotOnSameMountPoint => {
            ui_code("UPDATE_TEMP_DIR")
        }
        UpdaterError::PreviousAppNotRestored(_) => ui_code("UPDATE_PREVIOUS_KEPT"),
        UpdaterError::UnsupportedArch | UpdaterError::UnsupportedOs => {
            ui_code("UPDATE_UNSUPPORTED")
        }
        _ => ui_code("UPDATE_FAILED"),
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

/// Direction of an offered release relative to the installed version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Upgrade,
    /// Only on the stable channel: the installed (test) build is newer than the stable release.
    Downgrade,
}

/// Whether `release` is offered on `channel`. Newer is always an update; older only on the
/// stable channel (back from a test build) and only where the app installs itself; equal is
/// never offered.
fn offer<V: Ord>(
    channel: UpdateChannel,
    self_update: bool,
    current: &V,
    release: &V,
) -> Option<Direction> {
    match release.cmp(current) {
        std::cmp::Ordering::Greater => Some(Direction::Upgrade),
        std::cmp::Ordering::Less if channel == UpdateChannel::Stable && self_update => {
            Some(Direction::Downgrade)
        }
        _ => None,
    }
}

/// A manifest that could not be read while another one could; shown as a hint.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Skipped {
    manifest: UpdateChannel,
    error: String,
}

/// Picks the newest of the fetched manifests (first one wins on equal versions). Manifests
/// that failed are skipped and the first such failure is returned alongside; when all failed,
/// the first error is returned.
fn newest<T, V: Ord>(
    results: Vec<(UpdateChannel, Result<T, String>)>,
    version: impl Fn(&T) -> &V,
) -> Result<(T, Option<Skipped>), String> {
    let mut best: Option<T> = None;
    let mut skipped: Option<Skipped> = None;
    for (manifest, result) in results {
        match result {
            Ok(found) => {
                if best
                    .as_ref()
                    .is_none_or(|current| version(&found) > version(current))
                {
                    best = Some(found);
                }
            }
            Err(error) => {
                skipped.get_or_insert(Skipped { manifest, error });
            }
        }
    }
    match best {
        Some(found) => Ok((found, skipped)),
        None => Err(skipped.map_or_else(|| MSG_INVALID_DATA.to_owned(), |s| s.error)),
    }
}

/// Error of update_install when the offer cannot be confirmed: if the version changed while a
/// manifest failed in this run, that failure is the likely reason and is reported instead.
fn install_refusal(refusal: &'static str, skipped: Option<&Skipped>) -> String {
    match skipped {
        Some(skipped) if refusal == MSG_CHANGED => skipped.error.clone(),
        _ => refusal.to_owned(),
    }
}

/// The install must act on exactly what the check showed: same version, and a downgrade only
/// after the user confirmed it.
fn confirm_offer(
    direction: Option<Direction>,
    found_version: &str,
    expected_version: &str,
    allow_downgrade: bool,
) -> Result<(), &'static str> {
    let direction = direction.ok_or(MSG_NONE)?;
    if found_version != expected_version.trim() {
        return Err(MSG_CHANGED);
    }
    if direction == Direction::Downgrade && !allow_downgrade {
        return Err(MSG_DOWNGRADE_UNCONFIRMED);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Announced {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    direction: Option<Direction>,
}

fn announced(release: &RemoteRelease, direction: Option<Direction>) -> Announced {
    Announced {
        version: release.version.to_string(),
        notes: limit_notes(release.notes.clone()),
        pub_date: release.pub_date.and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        }),
        direction,
    }
}

type Seen = Arc<Mutex<Option<RemoteRelease>>>;

/// What one manifest announced, plus the installable update when its version differs from the
/// installed one and the manifest has a package for this install kind.
struct Fetched {
    release: RemoteRelease,
    update: Option<tauri_plugin_updater::Update>,
}

/// The release chosen across the channel's manifests, with the decision shown to the user.
struct Selection {
    fetched: Fetched,
    direction: Option<Direction>,
    skipped: Option<Skipped>,
}

fn build_updater(
    app: &AppHandle,
    kind: InstallKind,
    manifest: UpdateChannel,
    seen: Seen,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint: Url = manifest
        .endpoint()
        .parse()
        .map_err(|_| ui_code("UPDATE_BAD_URL").to_owned())?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| message(&e))?
        .timeout(CHECK_TIMEOUT)
        .configure_client(client_policy)
        // Records what the server announced, so deb/rpm/other can report a newer version
        // even when the manifest has no package for them. Every version other than the
        // installed one yields an Update; whether it is offered (newer, or a downgrade on the
        // stable channel) is decided afterwards by `offer`, the same way for check and install.
        .version_comparator(move |current, release| {
            let differs = release.version != current;
            if let Ok(mut slot) = seen.lock() {
                *slot = Some(release);
            }
            differs
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

/// Fetches one manifest. A missing package entry only counts as an error where the app
/// installs itself; deb/rpm/other just need the announced version.
async fn fetch(
    app: &AppHandle,
    kind: InstallKind,
    manifest: UpdateChannel,
) -> Result<Fetched, String> {
    let seen: Seen = Arc::default();
    let updater = build_updater(app, kind, manifest, seen.clone())?;
    let result = updater.check().await;
    let release = seen.lock().ok().and_then(|mut slot| slot.take());
    match (result, release) {
        (Ok(update), Some(release)) => Ok(Fetched { release, update }),
        (
            Err(UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_)),
            Some(release),
        ) if !kind.self_update() => Ok(Fetched {
            release,
            update: None,
        }),
        (Err(error), _) => Err(message(&error)),
        (Ok(_), None) => Err(MSG_INVALID_DATA.to_owned()),
    }
}

/// Fetches the manifests of `channel` (both at once on the test channel) and decides what is
/// offered. update_check and update_install both go through here, so they decide alike.
async fn select(
    app: &AppHandle,
    kind: InstallKind,
    channel: UpdateChannel,
) -> Result<Selection, String> {
    let results = match channel.manifests() {
        [only] => vec![(*only, fetch(app, kind, *only).await)],
        [first, second] => {
            let (a, b) = tokio::join!(fetch(app, kind, *first), fetch(app, kind, *second));
            vec![(*first, a), (*second, b)]
        }
        _ => return Err(MSG_INVALID_DATA.to_owned()),
    };
    let (fetched, skipped) = newest(results, |found: &Fetched| &found.release.version)?;
    let current = &app.package_info().version;
    let direction = offer(
        channel,
        kind.self_update(),
        current,
        &fetched.release.version,
    );
    Ok(Selection {
        fetched,
        direction,
        skipped,
    })
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
    /// Effective channel: the environment variable, else the setting passed in, else stable.
    channel: &'static str,
    /// True when WERKTERM_UPDATE_CHANNEL decided the channel (the setting is ignored then).
    channel_from_env: bool,
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
    /// The offered version is older than the installed one (stable channel, from a test build).
    downgrade: bool,
    /// Manifest ("test" or "stable") that could not be read while the other one was used.
    #[serde(skip_serializing_if = "Option::is_none")]
    skipped_manifest: Option<&'static str>,
    /// Error code of that manifest.
    #[serde(skip_serializing_if = "Option::is_none")]
    partial_error: Option<String>,
}

impl CheckResult {
    fn with_skipped(mut self, skipped: Option<Skipped>) -> Self {
        if let Some(skipped) = skipped {
            self.skipped_manifest = Some(skipped.manifest.as_str());
            self.partial_error = Some(skipped.error);
        }
        self
    }
}

impl From<Announced> for CheckResult {
    fn from(seen: Announced) -> Self {
        Self {
            available: seen.direction.is_some(),
            version: Some(seen.version),
            notes: seen.notes,
            pub_date: seen.pub_date,
            downgrade: seen.direction == Some(Direction::Downgrade),
            skipped_manifest: None,
            partial_error: None,
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
/// `channel` is the per-device setting of the frontend ("stable" or "test").
#[tauri::command]
pub fn update_info(app: AppHandle, channel: Option<String>) -> UpdateInfo {
    let kind = InstallKind::current();
    let blocked = current_block(&app, kind);
    let (channel, channel_from_env) = UpdateChannel::current(channel.as_deref());
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        install_kind: kind.as_str(),
        self_update: kind.self_update(),
        channel: channel.as_str(),
        channel_from_env,
        configured: pubkey_configured(&configured_pubkey(&app)),
        can_install: blocked.is_none(),
        blocked_reason: blocked,
    }
}

/// Fetches the manifest(s) of the effective channel. Never downloads a package.
#[tauri::command]
pub async fn update_check(app: AppHandle, channel: Option<String>) -> Result<CheckResult, String> {
    require_key(&app)?;
    let kind = InstallKind::current();
    let (channel, _) = UpdateChannel::current(channel.as_deref());
    let selection = select(&app, kind, channel).await?;
    Ok(
        CheckResult::from(announced(&selection.fetched.release, selection.direction))
            .with_skipped(selection.skipped),
    )
}

/// Downloads, verifies and installs the update for AppImage/NSIS/MSI. Does not restart:
/// on Linux the frontend calls `app_restart` afterwards; on Windows the installer ends this
/// process and starts the new version itself, so this command never returns there on success.
///
/// `version` is the version the check showed; the install repeats the same selection and stops
/// when it now finds another one. A downgrade needs `allow_downgrade` (the user confirmed it).
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    channel: Option<String>,
    version: String,
    allow_downgrade: bool,
    on_progress: Channel<InstallEvent>,
) -> Result<(), String> {
    let kind = InstallKind::current();
    // Same local checks as update_info, before any network access.
    if let Some(reason) = current_block(&app, kind) {
        return Err(reason.to_owned());
    }
    require_key(&app)?;
    let _guard = RunGuard::acquire().ok_or_else(|| MSG_RUNNING.to_owned())?;
    let (channel, _) = UpdateChannel::current(channel.as_deref());
    let selection = select(&app, kind, channel).await?;
    confirm_offer(
        selection.direction,
        &selection.fetched.release.version.to_string(),
        &version,
        allow_downgrade,
    )
    .map_err(|refusal| install_refusal(refusal, selection.skipped.as_ref()))?;
    let update = selection
        .fetched
        .update
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
        // Without a setting, only the environment variable decides.
        let env_only = |value| UpdateChannel::resolve(value, None).0;
        assert_eq!(env_only(None), UpdateChannel::Stable);
        assert_eq!(env_only(Some("")), UpdateChannel::Stable);
        assert_eq!(env_only(Some("beta")), UpdateChannel::Stable);
        assert_eq!(
            env_only(Some("https://example.org/x.json")),
            UpdateChannel::Stable
        );
        assert_eq!(env_only(Some("test")), UpdateChannel::Test);
        assert_eq!(env_only(Some(" TEST ")), UpdateChannel::Test);
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
            direction: Some(Direction::Upgrade),
        };
        let result = CheckResult::from(seen.clone());
        assert!(result.available);
        assert!(!result.downgrade);
        assert_eq!(result.version.as_deref(), Some("0.2.0"));
        let older = CheckResult::from(Announced {
            direction: None,
            ..seen.clone()
        });
        assert!(!older.available);
        assert!(!older.downgrade);
        let downgrade = CheckResult::from(Announced {
            direction: Some(Direction::Downgrade),
            ..seen
        });
        assert!(downgrade.available);
        assert!(downgrade.downgrade);
    }

    #[test]
    fn env_channel_wins_over_the_setting() {
        let resolve = UpdateChannel::resolve;
        assert_eq!(resolve(None, None), (UpdateChannel::Stable, false));
        assert_eq!(resolve(None, Some("test")), (UpdateChannel::Test, false));
        assert_eq!(
            resolve(None, Some("stable")),
            (UpdateChannel::Stable, false)
        );
        assert_eq!(resolve(None, Some("beta")), (UpdateChannel::Stable, false));
        assert_eq!(
            resolve(Some("test"), Some("stable")),
            (UpdateChannel::Test, true)
        );
        assert_eq!(
            resolve(Some(" Stable "), Some("test")),
            (UpdateChannel::Stable, true)
        );
        // Unknown or empty env values do not override the setting.
        assert_eq!(
            resolve(Some(""), Some("test")),
            (UpdateChannel::Test, false)
        );
        assert_eq!(
            resolve(Some("beta"), Some("test")),
            (UpdateChannel::Test, false)
        );
        assert_eq!(UpdateChannel::parse("TEST"), Some(UpdateChannel::Test));
        assert_eq!(UpdateChannel::parse("https://example.org/x.json"), None);
        assert_eq!(UpdateChannel::Stable.manifests(), &[UpdateChannel::Stable]);
        assert_eq!(
            UpdateChannel::Test.manifests(),
            &[UpdateChannel::Test, UpdateChannel::Stable]
        );
    }

    #[test]
    fn test_channel_offers_the_newer_of_test_and_stable() {
        fn version<'a>(found: &'a (&'static str, u32)) -> &'a u32 {
            &found.1
        }
        use UpdateChannel::{Stable, Test};
        let pick = |results: Vec<Result<(&'static str, u32), String>>| {
            let tagged = [Test, Stable].into_iter().zip(results).collect();
            newest(tagged, version).map(|(found, _)| found)
        };
        // Test build newer than stable.
        assert_eq!(
            pick(vec![Ok(("test", 12)), Ok(("stable", 11))]),
            Ok(("test", 12))
        );
        // A stable release that overtook the last test build.
        assert_eq!(
            pick(vec![Ok(("test", 11)), Ok(("stable", 12))]),
            Ok(("stable", 12))
        );
        // Equal versions: the first manifest (test) is kept.
        assert_eq!(
            pick(vec![Ok(("test", 12)), Ok(("stable", 12))]),
            Ok(("test", 12))
        );
        // One manifest fails: the other one is used.
        assert_eq!(
            pick(vec![Err("UPDATE_TIMEOUT".into()), Ok(("stable", 11))]),
            Ok(("stable", 11))
        );
        assert_eq!(
            pick(vec![Ok(("test", 12)), Err("UPDATE_UNREACHABLE".into())]),
            Ok(("test", 12))
        );
        // Both fail: the first error is reported.
        assert_eq!(
            pick(vec![
                Err("UPDATE_TIMEOUT".into()),
                Err("UPDATE_UNREACHABLE".into())
            ]),
            Err("UPDATE_TIMEOUT".into())
        );
        // The test channel never offers an older version.
        assert_eq!(
            offer(UpdateChannel::Test, true, &12, &13),
            Some(Direction::Upgrade)
        );
        assert_eq!(offer(UpdateChannel::Test, true, &12, &11), None);
        assert_eq!(offer(UpdateChannel::Test, true, &12, &12), None);
    }

    #[test]
    fn stable_channel_offers_a_downgrade_from_a_test_build() {
        assert_eq!(
            offer(UpdateChannel::Stable, true, &11, &12),
            Some(Direction::Upgrade)
        );
        assert_eq!(
            offer(UpdateChannel::Stable, true, &12, &11),
            Some(Direction::Downgrade)
        );
        assert_eq!(offer(UpdateChannel::Stable, true, &12, &12), None);
        // deb/rpm/other only report updates; a downgrade is left to the package manager.
        assert_eq!(offer(UpdateChannel::Stable, false, &12, &11), None);
        assert_eq!(
            offer(UpdateChannel::Stable, false, &11, &12),
            Some(Direction::Upgrade)
        );
    }

    #[test]
    fn compares_real_semver_versions() {
        let v = |s: &str| -> RemoteRelease {
            serde_json::from_value(serde_json::json!({"version": s, "url": "https://pkg.werklade.de/w/W-setup.exe", "signature": "x"}))
                .unwrap()
        };
        let current = v("1.2.0").version;
        assert_eq!(
            offer(UpdateChannel::Stable, true, &current, &v("1.1.0").version),
            Some(Direction::Downgrade)
        );
        assert_eq!(
            offer(UpdateChannel::Stable, true, &current, &v("1.10.0").version),
            Some(Direction::Upgrade)
        );
        assert_eq!(
            offer(UpdateChannel::Stable, true, &current, &v("1.2.0").version),
            None
        );
    }

    #[test]
    fn reports_the_manifest_that_was_skipped() {
        use UpdateChannel::{Stable, Test};
        let skipped = |manifest, error: &str| Skipped {
            manifest,
            error: error.into(),
        };
        let pick =
            |results: Vec<(UpdateChannel, Result<u32, String>)>| newest(results, |v: &u32| v);
        assert_eq!(pick(vec![(Test, Ok(12)), (Stable, Ok(11))]), Ok((12, None)));
        assert_eq!(
            pick(vec![(Test, Err("UPDATE_TIMEOUT".into())), (Stable, Ok(11))]),
            Ok((11, Some(skipped(Test, "UPDATE_TIMEOUT"))))
        );
        assert_eq!(
            pick(vec![
                (Test, Ok(12)),
                (Stable, Err("UPDATE_NO_PACKAGE".into()))
            ]),
            Ok((12, Some(skipped(Stable, "UPDATE_NO_PACKAGE"))))
        );

        let seen = Announced {
            version: "1.1.0".into(),
            notes: None,
            pub_date: None,
            direction: None,
        };
        let plain = serde_json::to_value(CheckResult::from(seen.clone())).unwrap();
        assert!(plain.get("skippedManifest").is_none());
        assert!(plain.get("partialError").is_none());
        let partial = serde_json::to_value(
            CheckResult::from(seen).with_skipped(Some(skipped(Test, "UPDATE_TIMEOUT"))),
        )
        .unwrap();
        assert_eq!(partial["skippedManifest"], "test");
        assert_eq!(partial["partialError"], "UPDATE_TIMEOUT");
        assert_eq!(partial["available"], false);
    }

    #[test]
    fn install_reports_the_failed_manifest_instead_of_a_changed_offer() {
        let failed = Skipped {
            manifest: UpdateChannel::Test,
            error: "UPDATE_UNREACHABLE".into(),
        };
        assert_eq!(
            install_refusal(MSG_CHANGED, Some(&failed)),
            "UPDATE_UNREACHABLE"
        );
        assert_eq!(install_refusal(MSG_CHANGED, None), MSG_CHANGED);
        // Other refusals are not caused by the failed manifest.
        assert_eq!(install_refusal(MSG_NONE, Some(&failed)), MSG_NONE);
        assert_eq!(
            install_refusal(MSG_DOWNGRADE_UNCONFIRMED, Some(&failed)),
            MSG_DOWNGRADE_UNCONFIRMED
        );
    }

    #[test]
    fn install_acts_only_on_the_confirmed_offer() {
        let up = Some(Direction::Upgrade);
        let down = Some(Direction::Downgrade);
        assert_eq!(confirm_offer(up, "1.2.0", "1.2.0", false), Ok(()));
        assert_eq!(confirm_offer(up, "1.2.0", " 1.2.0 ", false), Ok(()));
        assert_eq!(confirm_offer(up, "1.3.0", "1.2.0", false), Err(MSG_CHANGED));
        assert_eq!(confirm_offer(None, "1.2.0", "1.2.0", true), Err(MSG_NONE));
        assert_eq!(
            confirm_offer(down, "1.1.0", "1.1.0", false),
            Err(MSG_DOWNGRADE_UNCONFIRMED)
        );
        assert_eq!(confirm_offer(down, "1.1.0", "1.1.0", true), Ok(()));
        assert_eq!(
            confirm_offer(down, "1.0.0", "1.1.0", true),
            Err(MSG_CHANGED)
        );
    }

    #[test]
    fn serializes_the_ipc_contract() {
        let check = serde_json::to_value(CheckResult {
            available: true,
            version: Some("0.2.0".into()),
            notes: None,
            pub_date: Some("2026-11-13T10:00:00Z".into()),
            downgrade: false,
            skipped_manifest: None,
            partial_error: None,
        })
        .unwrap();
        assert_eq!(
            check,
            serde_json::json!({"available": true, "version": "0.2.0", "notes": null, "pubDate": "2026-11-13T10:00:00Z", "downgrade": false})
        );
        let info = serde_json::to_value(UpdateInfo {
            current_version: "0.1.8".into(),
            install_kind: "deb",
            self_update: false,
            channel: "stable",
            channel_from_env: false,
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
                "channelFromEnv": false,
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
        assert_eq!(text, "UPDATE_PREVIOUS_KEPT");
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
