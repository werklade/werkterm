# Release von Werkterm

Die CI baut und prüft die Pakete, veröffentlicht aber nichts. Veröffentlicht wird vom Veröffentlichungsrechner per SSH
über den Forced Command `werklade-publish` (Protokoll: `../packages/docs/publish-protokoll.md`).
Den GitHub-Pre-release legt der Nutzer von Hand an.

| Schritt | Wo | Was |
|---|---|---|
| 1 | Entwicklungs-PC | Version erhöhen, CHANGELOG, Commit, Tag |
| 2 | GitHub Actions | Workflow `Release build` (`.github/workflows/release.yml`) baut und bündelt |
| 3 | Veröffentlichungsrechner | Artefakt `werkterm-<version>` prüfen |
| 4 | GitHub (Web) | Pre-release von Hand anlegen |
| 5 | Veröffentlichungsrechner | `npm run publish-pkg` erst `test`, dann `stable` |

## Voraussetzungen

- Repository-Secrets (Settings > Secrets and variables > Actions):
  - `TAURI_SIGNING_PRIVATE_KEY`: privater Updater-Schlüssel (Inhalt der Schlüsseldatei). Ohne ihn bricht der
    Build ab, weil keine `.sig` entstehen.
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: Passwort dazu (leer lassen, wenn der Schlüssel keines hat).
  - Der öffentliche Schlüssel steht in `src-tauri/tauri.conf.json` unter `plugins.updater.pubkey`.
- Veröffentlichungsrechner: Node.js 22 oder neuer, OpenSSH-Client (`ssh`), GitHub CLI (`gh`, angemeldet mit Lesezugriff auf
  `werklade/werkterm`), Repo-Klon mit `npm ci`.
- SSH-Alias in `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`). Host, Adresse und Schlüssel stehen nur
  dort, nie im Repo. Beispiel mit Platzhaltern:

  ```
  Host werklade-pkg
      HostName <PKG_HOST>
      User <PKG_USER>
      IdentityFile ~/.ssh/werklade-deploy
      IdentitiesOnly yes
  ```

  Den Schlüssel und die Zeile in `authorized_keys` beschreibt das interne Betriebshandbuch,
  Schritt 10. Ein anderer Alias geht mit `--host <alias>`.
- Optional `ssh-agent`, damit die Passphrase nur einmal abgefragt wird (sonst fragt `ssh` bei jedem der bis zu
  vier Aufrufe):

  ```powershell
  # PowerShell als Administrator, einmalig: Dienst auf manuellen Start stellen
  Get-Service ssh-agent | Set-Service -StartupType Manual
  # PowerShell als Nutzer
  Start-Service ssh-agent
  ssh-add $HOME\.ssh\werklade-deploy
  ```

## 1. Version erhöhen

Die Version (SemVer `MAJOR.MINOR.PATCH`, ohne Buchstaben-Suffix und ohne führende Nullen) steht in drei Dateien
und muss überall gleich sein:

- `package.json` (`version`)
- `src-tauri/Cargo.toml` (`[package] version`)
- `src-tauri/tauri.conf.json` (`version`)

`cargo` passt `src-tauri/Cargo.lock` beim nächsten Build an. In `CHANGELOG.md` den Abschnitt `## [Unreleased]`
in `## [<version>] – <JJJJ-MM-TT>` umbenennen und darüber einen leeren `## [Unreleased]` anlegen. Dieser Abschnitt
wird Text der Update-Meldung (`notes` in `latest.json`, höchstens 20000 Zeichen) und des GitHub-Release.

```bash
# Git Bash, im Repo
node scripts/release-bundle.mjs --print-version     # gibt die Version aus oder nennt die abweichende Datei
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm test
git commit -am "Release 0.1.9"      # Beispielversion
git tag v0.1.9
git push origin main v0.1.9
```

Eine veröffentlichte Version wird nie neu gebaut. Korrektur = neue, höhere Version.

## 2. CI

Der Tag `v<version>` startet den Workflow. Ohne Tag: Actions > `Release build` > `Run workflow`; die Version kommt
dann aus den drei Dateien. Jobs:

- `check`: Versionsgleichheit (bei Tag-Lauf auch mit dem Tag), `npm run build` (tsc und Vite), `npm test`,
  `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`. `npm run check-design` läuft nicht, weil es das
  private Nachbar-Repo `../design` braucht; vor dem Tag lokal ausführen.
- `linux` und `windows`: `npm run tauri build` mit Updater-Signaturen, `npm run check-paths`, Prüfung der
  Dateinamen.
- `bundle`: `scripts/release-bundle.mjs` erzeugt das Artefakt `werkterm-<version>` (30 Tage aufbewahrt). Bei einem
  Tag-Lauf muss `CHANGELOG.md` den Abschnitt `## [<version>]` enthalten (`--require-changelog-section`), sonst
  bricht der Job ab; ein manueller Lauf nimmt ersatzweise `## [Unreleased]`.

Caches: Nur der `check`-Job schreibt den Rust-Cache. Die Jobs `linux` und `windows` haben den Signierschlüssel und
schreiben keine Caches (`linux` liest den Rust-Cache von `check`, `windows` baut ohne Rust-Cache; npm-Cache nur in
`check`). So kann ein manipulierter Cache aus einem Signierlauf nicht in spätere Läufe gelangen.

## 3. Artefakt prüfen

Inhalt von `werkterm-<version>`:

| Datei | Zweck |
|---|---|
| `Werkterm_<v>_amd64.AppImage`, `Werkterm_<v>_x64-setup.exe`, `Werkterm_<v>_x64_en-US.msi` und je `.sig` | Updater-Artefakte |
| `Werkterm_<v>_amd64.deb` | APT |
| `SHA256SUMS` | Server-Fassung (ohne .deb) |
| `latest.json` | Update-Daten |
| `release-<v>.tar` | Eingabe für `release`/`release-test` |
| `github/SHA256SUMS` | Prüfsummen aller vier Pakete inkl. .deb, für den GitHub-Release |
| `github/RELEASE-TEXT.md` | Release-Text (Added/Changed/Fixed, Downloads, Hinweis APT/Updater) |

```bash
# Git Bash, im Repo; <run-id> aus der Actions-Seite oder "gh run list --workflow release.yml"
gh run download <run-id> -n werkterm-0.1.9 -D ../werkterm-release-0.1.9
cd ../werkterm-release-0.1.9
sha256sum -c SHA256SUMS && sha256sum -c github/SHA256SUMS
```

Die Pakete stichprobenartig installieren (Windows: NSIS-Installer; Linux in WSL: AppImage und .deb).

## 4. GitHub-Pre-release

Von Hand auf GitHub: Releases > Draft a new release, Tag `v<version>`, Titel `Werkterm <version>`, Text aus
`github/RELEASE-TEXT.md`, „Set as a pre-release“ anhaken. Anhänge: die vier Pakete und `github/SHA256SUMS`
(als `SHA256SUMS`).

## 5. Veröffentlichen

Vorher die Server-Sicherung nach `../packages/docs/betrieb.md`, Abschnitt 7.1. Das Skript sichert bei `stable`
zusätzlich die öffentliche `latest.json` als `werkterm-updates-<vorige Version>.json` in einen festen Ordner und
nennt den Pfad am Ende:

| System | Ordner |
|---|---|
| Windows | `%LOCALAPPDATA%\werkterm-publish\backups` |
| Linux | `$XDG_STATE_HOME/werkterm-publish/backups`, sonst `~/.local/state/werkterm-publish/backups` |

Eine vorhandene gleichnamige Sicherung mit anderem Inhalt wird nicht überschrieben (neue Datei mit Zeitstempel).

```bash
# Git Bash oder PowerShell, im Repo
npm run publish-pkg -- 0.1.9 --channel test --run <run-id> --dry-run   # zeigt nur die Befehle
npm run publish-pkg -- 0.1.9 --channel test --run <run-id>
# Test-Kanal mit einer Testinstallation prüfen (Updates-Test-Kanal), dann:
npm run publish-pkg -- 0.1.9 --channel stable --run <run-id>
```

Mit bereits heruntergeladenem Ordner statt `--run`: `--from ../werkterm-release-0.1.9`. Ohne `--from` lädt das
Skript per `gh run download` in einen temporären Unterordner und benennt ihn erst nach Erfolg in
`<Temp>/werkterm-publish/<version>/run-<run-id>` um (ein vorhandener Download wird wiederverwendet und erneut
geprüft).

Ablauf des Skripts (Abbruch beim ersten Fehler, der Exit-Code des Servers wird durchgereicht, Meldungen
`werklade-publish:` erscheinen unverändert; jeder Abbruch nennt, was auf dem Server schon geändert ist):

1. Artefakt bereitstellen.
2. Dateien, `SHA256SUMS`, `github/SHA256SUMS` (auch für das .deb) und `latest.json` nach den Server-Regeln prüfen;
   `release-<v>.tar` wird in Node gelesen (ustar-Header): nur reguläre Dateien mit erlaubten Namen, Inhalt
   identisch mit den geprüften Einzeldateien.
3. `ssh werklade-pkg "status werkterm"` anzeigen. Abbruch, wenn die Version zurückgenommen ist, bei einer neuen
   Version schon 40 Versionsordner auf dem Server liegen oder bei `stable` eine höhere Version auf `stable` oder in
   APT steht (Downgrade). Liegt `downloads/<v>/` schon auf dem Server, wird dessen `SHA256SUMS` geladen und
   byteweise mit dem lokalen verglichen; bei Abweichung Abbruch, bevor etwas hochgeladen wird. Bei `stable`:
   `latest.json` sichern.
4. Nur `stable`: `ssh werklade-pkg "deb werkterm <v>" < Werkterm_<v>_amd64.deb`. Im Kanal `test` wird das .deb
   nicht hochgeladen, weil das APT-Repo nur `stable` kennt und jedes eingespielte Paket sofort öffentlich ist.
5. `ssh werklade-pkg "release-test werkterm <v>"` bzw. `"release werkterm <v>"` mit `release-<v>.tar`.
6. Erneut `status`: `release_test` bzw. `release` muss `<v>` sein, bei `stable` muss APT `<v>` enthalten.

Ein Wiederholungslauf derselben Version mit demselben Artefakt ist unkritisch (Server antwortet idempotent).

Verifikation von außen:

```bash
# Git Bash, beliebiger Rechner
curl -fsS https://pkg.werklade.de/werkterm/updates/latest.json | head -c 300
curl -fsS https://pkg.werklade.de/werkterm/updates-test/latest.json | head -c 300
```

Scheitert `release`/`release-test` nach einem erfolgreichen `deb`, ist das .deb im APT-Repo, `latest.json` aber
unverändert. Denselben Aufruf wiederholen: `deb` und `release` sind für denselben Inhalt idempotent.

## Härtung (optional)

Derzeit sind die Signier-Secrets Repository-Secrets; Schreibrecht auf das Repo hat nur der Betreiber. Strenger:

1. Settings > Environments > `release` anlegen, unter „Deployment branches and tags“ nur Tags `v*` und den Branch
   `main` zulassen.
2. `TAURI_SIGNING_PRIVATE_KEY` und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` dorthin verschieben (als Repository-Secrets
   löschen) und in den Jobs `linux` und `windows` `environment: release` setzen.
3. Settings > Rules > Rulesets: Tag-Ruleset für `v*` (Erstellen, Ändern und Löschen nur für den Betreiber).

Rückweg: Secrets wieder als Repository-Secrets anlegen, `environment:` entfernen, Ruleset deaktivieren.

## Rücknahme

Fehlerhafte Version: `../packages/docs/betrieb.md`, Abschnitt 7 (sperren, `latest.json` aus der Sicherung
zurücksetzen, APT). Danach eine höhere, korrigierte Version mit diesem Ablauf veröffentlichen.
