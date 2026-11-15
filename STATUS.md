# STATUS – Werkterm

Stand: 2026-11-14

## Erledigt
- Werkzeuge (Windows): MSVC Build Tools 14.44 + SDK 10.0.26100, Rust 1.99.1 (msvc), Node 26.13.0,
  Ollama 0.40.14, Codex CLI 0.167.0, agy 1.5.2.
- WSL2 Ubuntu-24.04: Tauri-Linux-Abhängigkeiten, Rust 1.99.1, Node 26.13.0 (nvm), Klon unter ~/werkterm.
  Test-sshd auf 127.0.0.1:2222 (nur Testsystem).
- Codex-Sandbox (elevated) funktioniert: Projektordner gehörte "Administratoren" -> Besitzer auf
  Benutzer umgestellt; `.claude/settings.local.json` in .gitignore (Sandbox liest globale Git-Ignore nicht).
- Phase 1 (abgenommen):
  - Tauri-2-Grundgerüst (react-ts, npm), vorläufiger Identifier, Bundle-Ziele nur deb/appimage.
  - Lokales Terminal (`src-tauri/src/pty.rs`, portable-pty 0.9): PowerShell 7 (Fallback 5.1) bzw. $SHELL,
    WSL-Tab; Rohbytes über Tauri-Channel; Writer-Lock pro Sitzung.
  - Hauptfenster mit Menü-/Symbolleiste, Icon-Leiste, Terminal-Tabs (@xterm/xterm 6 + addon-fit).
  - Icons: Tabler Icons 3.50.0 (MIT) + eigene Zeichnungen Taschenmesser/Tux; dunkles Theme (Ollama).
  - CSP aktiv (`csp` streng, `devCsp` für Vite-HMR).
- Phase 2 (abgenommen bis auf Korrekturrunde, siehe In Arbeit):
  - SSH-Engine `src-tauri/src/ssh/` (russh 0.65.1 mit ring-Backend, russh-sftp 3.0.1): EINE Verbindung,
    Kanal SFTP + Kanal PTY-Shell; Fallback exec `ls -la --time-style=+%s --quoting-style=c`.
  - Hostkey-Prüfung gegen known_hosts: unbekannt -> Dialog mit SHA256-Fingerprint, geändert -> Abbruch.
  - Anmeldung: ssh-agent (Unix-Socket / Windows-Pipe), id_ed25519/id_ecdsa/id_rsa (Passphrase-Dialog),
    Passwort-Dialog; Geheimnisse nur im Speicher, nie geloggt.
  - Alle Adressen werden nacheinander probiert (localhost -> ::1 hängt bei WSL mirrored networking).
  - Zeitlimits je Aufbauphase (ohne Prompt-Zeit), Aufbau beim Schließen des Tabs abbrechbar.
  - SSH-Browser zeigt immer das Verzeichnis des aktiven Tabs: SSH (SFTP/exec), lokal (PowerShell),
    WSL (\\wsl.localhost\<Distro>\...). Folgt OSC 7 (abschaltbar); Hooks kodieren Pfade als URI.
    PowerShell-Prompt-Hook bzw. Bash-PROMPT_COMMAND (lokal/WSL) und optionaler Einzeiler für SSH-Bash.
  - Navigation: Doppelklick, Ordner hoch, Refresh, editierbares Pfadfeld. Dateiaktionen folgen in 2b.
- Tests: cargo test 31/31 (+1 ignorierter Live-SSH-Test); Vitest 100/100.

- Phase 2b (abgenommen 2026-11-07): Download/Upload (Dialog + Drag & Drop, gestreamt, Fortschritt, Abbruch),
  Neuer Ordner, Neue Datei, Löschen (rekursiv mit Bestätigung, folgt nie Symlinks) – nur SSH+SFTP.
  Echo-Fix für den OSC-7-Einzeiler. Nur die Dateiliste scrollt; lokaler Pfad ohne `\\?\`-Präfix.
- Transfer-Warteschlange (getestet 2026-11-07): App-weit, Transfers laufen bei Tab-/Panelwechsel weiter;
  Schließen eines SSH-Tabs bricht nur dessen Transfers ab.

- Phase 2c (abgenommen 2026-11-07): gespeicherte Sitzungen (sessions.json ohne Geheimnisse, Passwörter nur im
  OS-Keyring via keyring 4.2.0, Linux zbus ohne Systempakete), Stern-Panel mit Ordnerbaum/Suche,
  "Verbindung speichern?" nach Quick connect (Passwort vorgewählt), Import MobaXterm/WindTerm (OneKey-Zuordnung),
  .ppk-Schlüssel. Kanal-Reihenfolge Shell vor SFTP (PAM-MOTD/aktuelles Last login sichtbar, getestet auf CT).
  Codex-Review: 5 Befunde behoben; "Agent vor gewähltem Modus" bewusst beibehalten (wie OpenSSH/MobaXterm).
  Anmeldeart bleibt Dropdown (Wunsch), Eingabefeld direkt darunter. Tests: cargo 48/48 (+1 ignoriert); Vitest 112/112.

- Phase 3 MobaTextEditor (abgenommen 2026-11-07):
  - Backend (1d4d0fe): Laden/Speichern SFTP + lokal/WSL, in-place, Konfliktschutz, EOL-/BOM-Erkennung,
    Fixtures tests/fixtures/eol/. Sessions haben Feld kind ("ssh"). CodeMirror 6.x exakt gepinnt (5fcff81).
  - Frontend (c016f2c): Editor-Tab, Zeilennummern, Faltung (Syntax, sonst Einrückung/Klammern), Syntaxfarben lazy,
    Suchen/Ersetzen, Farbcode-Hinterlegung (BT.601, L>140 schwarz), EOL-Buttons Win/Tux/Apple mit Mixed-Warnung,
    Statusleiste Z/Sp, Strg+S mit Konfliktdialog; SSH-Browser mit fixierten Überschriften und Sortierung;
    Sitzungs-Icon nach kind. Getestet: EOL-Umwandlung byte-genau (od -c), Konfliktdialog, Farbcodes.
  - Review-Fixes (124f50a): Rückfrage beim Fenster-Schließen, Editor-Sperre bei Schließen/Neu laden, Prüfung am
    geöffneten Handle, lokale Sicherung + WRITE_FAILED-Meldung, Cache pro Instanz mit Lock-Datei. Nicht umgesetzt:
    Inhalts-Fingerabdruck gegen gleich große Änderung in derselben Sekunde (selten, bräuchte erneuten Download).
  - Wünsche: schwarzer Inhaltshintergrund (--bg-content), Seitenpanel und Listenspalten per Ziehen verbreiterbar.
  - Tests: cargo Windows 60, Linux 62 (+1 ignoriert); Vitest 162/162.
- AGENTS.md (von der ChatGPT-Desktop-App angelegt) aus dem Projektordner entfernt, in .gitignore.

- Phase 4 (abgenommen 2026-11-07):
  - Erledigt: sudo-Modus für den SSH-Browser (Schlüssel-Icon, sudo -n bzw. -k -S, Passwort nie gespeichert),
    chmod-Dialog per Kontextmenü (rekursiv, Ordner/Dateien getrennt, Symlinks nie verfolgt); CLAUDE.md 3.A angepasst.
  - Erledigt: Linux-PTY (abbrechbares Lesen, Kill der Prozessgruppe mit SIGKILL-Eskalation); Code-Splitting (keine Bundle-Warnung).
  - Erledigt: App-Icon (src-tauri/app-icon.svg), deb/AppImage-Metadaten, Desktop-Eintrag; Pakete in WSL gebaut,
    .deb installiert und gestartet (WSLg). Funde daraus behoben: Quick connect ohne Benutzer, Emoji-Schriften,
    dunkle Auswahllisten unter GTK, genaue Schlüsselbund-Fehler, Augensymbol für neue Passwörter.
  - Erledigt: Lizenz GPL-3.0-or-later; Git-Identität "Marc-Andre Kolski <344019908+Elaktyl@users.noreply.github.com>"
    (lokal gesetzt, Historie umgeschrieben, Sicherung: Branch backup/pre-identity-rewrite). Historie auf
    private Daten/Geheimnisse geprüft: nichts gefunden.
  - Erledigt: Umbenennung in Werkterm (DPMA: 0 Treffer; EUIPO ungeprüft), Identifier de.werklade.werkterm, Paket/Befehl werkterm,
    "MobaTextEditor" -> "Editor"; Übernahme sessions.json (Kopie) und Keyring-Einträge vom alten Identifier.
    Oberflächen-Einstellungen (localStorage) beginnen neu. Die Übernahme wurde 2026-11-14 für 1.0.0 wieder entfernt.
    Getestet: sessions.json übernommen, Keyring-Eintrag beim ersten Verbinden nach de.werklade.werkterm migriert.
  - Pakete als werkterm neu gebaut (Werkterm_0.1.0_amd64.deb/.AppImage), Paketdaten und Desktop-Eintrag geprüft.
  - Zurückgestellt bis Projektabschluss: README/README.de/CHANGELOG/docs (Auftrag prompts/codex-docs.txt), Screenshots, Push.
  - Tests: cargo Windows 74, Linux 78 (+1 ignoriert); Vitest 191/191.

- Phase 5a (abgenommen 2026-11-07): Menüs mit Funktion und Tastatursteuerung (F10, Alt+Buchstabe außerhalb von
  Terminal/Editor), Werkzeugleiste (Sessions -> "Neue Sitzung", Tools -> Ausklappmenü, Macros deaktiviert),
  Einstellungen-Dialog (Schrift, Cursor, Scrollback, Farbschemata, Import MobaXterm [Colors]), Hilfe/Über,
  Remote-Monitoring-Leiste (nur lesendes Skript, ein exec-Kanal), MultiExec (Raster, Checkbox je Terminal, nur
  Benutzereingaben, Paste je Ziel kodiert, Rückfrage), Keepalive pro Sitzung. xterm exakt auf 6.0.0 gepinnt
  (MultiExec nutzt interne Herkunftserkennung, fällt sicher auf "nichts verteilen" zurück).
  Tests: cargo Windows 80, Linux 84 (+1 ignoriert); Vitest 208/208.

- SSH-OSC-7-Hook: PROMPT_COMMAND wird nicht mehr exportiert und prüft per declare -F, ob __werkterm_osc7 existiert; behebt "command not found" nach pct enter/su/tmux (0.1.7, in WSL-Bash mit Kind-Shells geprüft).

## In Arbeit
- Sprachpakete Deutsch/Englisch (2026-11-13, Plan freigegeben, Etappen A–D):
  - Erledigt, Etappe A (63320c9): eigenes Lookup src/i18n/ (index.ts, de.json Quelle, en.json; ohne neue Abhängigkeit),
    Einstellung language (system/de/en, gerätelokal, Tab „Allgemein“), Menüs/Werkzeugleiste/Seitenleiste/Tabs/Startseite/Kürzelhilfe übersetzt,
    Menüs und Einstellungstabs über ids statt Anzeigetext, Gebietsschema statt fest „de-DE“. Tests prüfen gleiche Schlüssel und
    Platzhalter in de/en, jeden t("…")-Schlüssel im Code, Stil (kein „bitte“, „!“, du/Sie). Vitest 706 (+2 übersprungen), Build ohne Fehler.
  - Erledigt, Etappe B (a35210b): alle übrigen Komponenten über t()/tp() (de.json/en.json je ~1220 Schlüssel, gemeinsame
    common.*-Knöpfe), CodeMirror-/MergeView-Phrasen, Logikwerte statt Anzeigetext (ask()-Ergebnis, folderDiff-Kategorien,
    Design-/Theme-Namen als IDs mit *Label()), Tab-Titel per titleKey beim Rendern übersetzt, Stilkorrekturen. i18n in core.ts
    (ohne React, für Test-Setup) und index.ts (Hooks). Vitest 707 (+2 übersprungen), Build ohne Fehler, Review ohne kritische Befunde.
  - Erledigt, Etappe C (1da71b6): Backend-Meldungen als Codes. src-tauri/src/ui_error.rs (UiError: `CODE` bzw.
    `CODE: {"args":{…},"detail":"…"}`, log_line(), json_position()), Frontend src/lib/backendError.ts (errorText/errorCode, verschachtelte
    Fehler, Pluralformen), ~330 error.*-Schlüssel. Rust-Logik prüft Codes statt Text (Tunnel-Abbruch, SFTP_ONLY, Keyring, sudo).
    Telnet/Seriell-Hinweise als {"notice": …} über denselben Channel (src/lib/terminalNotice.ts). Rust-Test prüft jeden Code und jede
    Argument-Platzhalter gegen de/en.json. cargo Windows 229 / Linux (WSL) 238 (+1 ignoriert), Vitest 720 (+2 übersprungen), clippy ohne
    Warnung, Build ohne Fehler, Review ohne kritische Befunde.
  - Erledigt, Etappe D (c56c1a1): .desktop-Vorlage mit Comment (EN) und Comment[de] (aus shortDescription), longDescription
    „Sprungserver“ statt „Jump hosts“. desktop-file-validate ohne Fehler (siehe Testsatz). Ungeprüft: Anzeige im Menü.
    Testsatz 0.1.10-build3 (2026-11-14, lokal in WSL aus d0380c3, unsigniert; ersetzt build2 für den Test): logs/werkterm-test/0.1.10-build3/
    (.deb 7,3 MiB, AppImage 91 MiB mit 109 GStreamer-Bibliotheken, SHA256SUMS, BUILD.txt). desktop-file-validate in beiden ohne Befund
    (Categories=System;TerminalEmulator;), appstreamcli im .deb ohne Befund, check-paths 0 Treffer. Vom Nutzer auf einem Linux-Desktop getestet (2026-11-14):
    .deb und AppImage laufen, Deutsch und Englisch korrekt.
    Testsatz 0.1.10-build2 (2026-11-14, lokal in WSL aus 527b94c, unsigniert): logs/werkterm-test/0.1.10-build2/ (.deb 7,3 MiB,
    AppImage 91 MiB, SHA256SUMS, BUILD.txt); Desktop-Eintrag mit Comment/Comment[de] in beiden; check-paths 0 Treffer. AppImage-Bau in WSL
    braucht patchelf (seit 2026-11-14 in WSL installiert, ebenso desktop-file-utils). desktop-file-validate: beide Einträge gültig,
    nur Hinweis „mehr als eine Hauptkategorie“ (Network;System); behoben: Categories=System;TerminalEmulator; (auch in der
    AppStream-Metainfo), gerenderte Vorlage gültig. AppStream-URLs (homepage, vcs-browser = github.com/werklade/werkterm, bugtracker …/issues) ergänzt,
    appstreamcli ohne Befund; CI-Ausnahme url-homepage-missing entfernt. Links gehen für andere erst nach dem Public-Schalten.
    Sprachwechsel von Hand geprüft (2026-11-14, ohne Befund): Windows; Linux/WebKitGTK in WSL (Dev-Build), Systemsprache per LANG=de_DE bzw. en_US richtig erkannt; Linux-Pakete build3 auf Desktop-System ohne Befund;
    Sprachwechsel des Systems zur Laufzeit wird nicht übernommen; bereits gesetzte Statusmeldungen wechseln die Sprache erst mit der nächsten Meldung.
- Werkzeugleiste/Startbildschirm nach MobaXterm (2026-11-07):
  - Erledigt (c33c9e3): Home-Tab (kein Auto-Terminal, Wiederherstellen letzter Tabs, Suche + Quick connect, Zuletzt verwendet;
    recent.json/last-tabs.json ohne Geheimnisse), Werkzeugleiste Session/Sessions/Lokales Terminal/WSL/Tools/View/Split/MultiExec/
    Settings/Help/Beenden mit Ausklappmenüs, View-Optionen, Linux-Werkzeuge Root-Terminal/Prozesse/Hardware. Tests: cargo 85, Vitest 216.
  - Erledigt (3658a8e): Split-Ansicht (aus Phase 6 vorgezogen: 1/2 nebeneinander/2 untereinander/4, Bereichsauswahl, ziehbare Trenner),
    SSH-Schlüssel erzeugen (Ed25519/RSA, Passphrase, privater Schlüssel nur beim Speichern, 0600), ASCII-Tabelle, Offene lokale Ports (nur lesend).
  - Erledigt (d24ac81): Rückfrage beim Schließen aktiver SSH-Verbindungen (Tab, Fenster, Beenden; abschaltbar), Review-Fixes
    (Alt/AltGr im Terminal, netstat deutsch, beschädigte recent/last-tabs-Dateien -> .bak, Windows-Hinweis Keygen). Neue Symbole Session/MultiExec/Settings.
  - Tests: cargo Windows 92, Linux 96 (+1 ignoriert); Vitest 232/232. Offen: Test der Rückfrage im Fenster.
- Phase 5b abgenommen (2026-11-07):
  - ae8e5e5: Jump host pro Sitzung (Kette bis 5 Hops, Hostkey/Auth je Hop, Zyklus- und Löschschutz, MobaXterm-Gateway-Import).
  - dda30e3: Tunnel-Manager (Tools > SSH-Tunnel): -L/-R/SOCKS5, tunnels.json, eigene Hintergrundverbindung, Loopback-Default,
    öffentlicher Bind nur mit Bestätigung, Autostart, Reconnect, Status/Zähler, max. 256 Verbindungen pro Tunnel. Codex-Review: 2 mittlere Befunde behoben.
  - Tests: cargo Windows 112, Linux 116 (+1 ignoriert); Vitest 241/241. Nutzertest gegen echte Server bestanden.
- Phase 6a abgenommen (2026-11-07):
  - d274f99: Icons je Verbindungsart, Sitzungs-Logging (Einstellung/Sitzung/Tab-Menü, ANSI-Filter, 0600), Einfügen mit Rückfrage (bearbeitbar, Steuerzeichen-Warnung).
  - e30fe51: Log-Schreiben in eigenem Thread mit begrenzter Queue (Review-Befund hoch).
  - 5680477: Terminal-Kontextmenü (Kopieren, Alles kopieren, Speichern als TXT/HTML/RTF mit Farben, Leeren, Protokoll), Strg+Umschalt+C/Einfg-Kürzel,
    automatisch kopieren, Rechtsklick wahlweise Einfügen; Jump host als Inline-Hinweis statt Badge.
  - Tests: cargo Windows 121, Linux 125 (+1 ignoriert); Vitest 254/254.
- Phase 6b abgenommen (2026-11-07):
  - 329fcaa: Telnet (ECHO/SGA/TTYPE/NAWS, Hinweis unverschlüsselt, telnet://-Quick-connect) und Seriell (serialport 4.10.1 ohne libudev, Portliste, 8N1/Fluss,
    Enter-Umsetzung, lokales Echo, Break); Sitzungsdialog mit Art SSH/Telnet/Seriell.
  - 70ad86d: Review-Befunde (seriellen Writer bei Flusskontroll-Stau freigeben, Import-Duplikate nach Art, Typwechsel-Schutz für Tunnel/Jump host).
  - tests/manual/telnet_test_server.py: Loopback-Telnet-Testserver (Python, WSL).
  - Tests: cargo Windows 138, Linux 142 (+1 ignoriert); Vitest 264/264. Telnet im Nutzertest ok; USB-Seriell-Adapter wird erkannt.
- Phase 6c abgenommen (2026-11-07):
  - 82b80ad, 9bc8b06, ad26a9f, 9c8df64, 4082679: Tux-Wanderer (Pixel-Art-Tuxe fallen, laufen auf dem Text, graben sichtbare Löcher – nur gezeichnet,
    Puffer unverändert –, verlassen das Bild durch eine Klappecke). Klick/Taste beendet (Eingabe geht durch), Mausbewegung nicht.
    Einstellungen: aktiv, Inaktivität 1–120 min, Anzahl 1–8 (Standard 4), "Jetzt testen".
  - Nachträge 59569b8, 0c4911d, 01c34f5, b9a5cd0: Menü "Tools > Tux-Wanderer starten", MultiExec im Tools-Menü bündig, Laufanimation am Rand,
    Winken während die Ecke langsam aufklappt, Grab-Animation (Schaufeln, schubweises Einsinken, fliegende Erde und Buchstaben, Staub).
- Nachträge nach Phase 6 (2026-11-07, abgenommen):
  - a14470b: Baudrate als Dropdown mit Standardwerten + "Andere…"; neu angelegte Sitzungen verbinden nach dem Speichern sofort.
  - 33c2d57: Nach Sitzungsende Auswahl im Terminal: Return schließt Tab, R startet neu (gleicher Tab, leerer Bildschirm), S speichert Ausgabe.
  - Seriell mit FortiGate-60F über USB-Adapter erfolgreich getestet (Login-Prompt).
  - 4c7b815: MultiExec scrollt jedes Ziel-Terminal bei Eingabe ans Ende (Nutzertest ok).
  - 4791ebb, 4b34e33, 9af771f: Monitoring nach MobaXterm-Vorbild: eigene Tooltips für alle Felder (Host/Version, CPU-Last + Verlauf,
    RAM-Tabelle, Up/Down je Schnittstelle, Laufzeit, who, df), Laufwerke nach Rang (/ /boot /tmp, dann /mnt /media /srv), Pseudo-FS ausgeblendet,
    so viele Felder wie Platz, +N mit Liste, >=90 % rot; Benutzer "name (xN)". Tests: cargo Windows 139, Linux 143; Vitest 280 (Nutzertest ok).
  - 76a1db1: Debian-Open-Use-Logo (debian.org, LGPL-3+/CC BY-SA 3.0) für Debian-Hosts, sonst farbige Buchstabenkreise (ID/ID_LIKE);
    andere Distro-Logos bewusst nicht (Markenrichtlinien geprüft: nur Debian klar erlaubt).
  - 4833d05, 171f933, f1971ef: Tools-Panel aus dem Tools-Menü, Seitenpanel per erneutem Klick einklappbar, Quick connect bleibt sichtbar.
  - 6754efb … 2f41d42: Tux flattert beim Fallen (langsamer), rutscht auf dem Bauch, läuft im Profil, bleibt im Terminal,
    gräbt frontal mit gelbem Helm, Schaufel (seitliches Auswerfen) oder Presslufthammer. Vitest 284/284 (Nutzertest ok).
  - f1b8754, d7efdb7: zufällige dunkle Tux-Körperfarben (kein Weiß/Orange/Gelb/Grau/Braun, per Test abgesichert).
- Platzhalter vor Abschluss (2026-11-08):
  - 7e7f38e: Dateien vergleichen (@codemirror/merge 6.12.3, MIT; read-only, lokal/remote/gemischt, Navigation, Leerzeichen ignorieren, Im Editor öffnen).
  - 91b90c1: Makros (Aufnahme mit Klartext-Warnung, Editor mit Text/Warten/Rückfrage, Abspielen inkl. MultiExec, Tastenkürzel; AltGr löst nicht aus – Nutzertest ok).
  - 6dda6dd: Review-Fixes (Dokumente immer freigeben, Rückfragewerte früh verwerfen, Leerzeichen ignorieren <= 1 MB). Makros umgehen die Einfüge-Rückfrage bewusst.
  - 272bdc0: Quick connect fest in eigener Kopfzeile (Einklappen verschiebt nichts); Ordnervergleich inkl. Unterordner, Inhaltsvergleich mit Fortschritt/Abbruch.
  - 02e2ace: Linux-Hilfe bei fehlender Seriell-Berechtigung (Gruppe ermitteln, sudo/doas/pkexec/su + usermod/gpasswd/addgroup/adduser, Ausführung im lokalen Terminal
    nach Bestätigung, Installationshinweis ohne Werkzeuge). Offen: Test mit echtem Gerät im Linux-Paket.
  - 8cdee43, a802ca4: Dialog-Checkboxen neben ihrem Text, Vergleichsdialog aufgeräumt.
  - Tests: cargo Windows 152, Linux 157 (+1 ignoriert); Vitest 320/320.
- Projektabschluss (2026-11-08):
  - c627139: MobaXterm aus Paket-Metadaten entfernt (Startmenü-Stichwort, Paketbeschreibung); Import-Funktionen nennen MobaXterm nur beschreibend.
  - 8416d65: README (EN/DE) mit Unabhängigkeits-/Markenhinweis, CHANGELOG, docs/architektur.md.
  - Pakete gebaut (WSL): Werkterm_0.1.0_amd64.deb, Werkterm_0.1.0_amd64.AppImage.
  - GitHub: Organisation "werklade" (Logo: oranges W als oberste Werkzeuglade), privates Repo werklade/werkterm, main gepusht (154 Commits geprüft:
    nur Noreply-Identität, keine privaten Daten). Tester bekommen die Org-Rolle "Read" (persönliche private Repos können nur Schreibzugriff vergeben).
  - 8c76356: Mehrfachauswahl und Sammel-Löschen in der Sitzungsliste.
  - Linux-Test in einem Wegwerf-Container (Debian 13, X11-Weiterleitung): .deb installiert sauber. Gefunden und behoben: 73fb769 (Log-Ordner ohne
    Documents -> ~/Werkterm-Logs), 0a74638 (Zwischenablage über tauri-plugin-clipboard-manager 2.5.0, Speichern ohne Schlüsselbund, Zähler ab 2,
    Icons, Hardware-Übersicht wie MobaXterm). WSLg: WebKitGTK-Webprozess stirbt bei Fokusverlust (auch minimales WebKit-Fenster) – kein Werkterm-Fehler.
  - 3ff3df5, ae4436b: Linux-Screenshots in der README, CHANGELOG 0.1.0 datiert, Release-Text unter logs/werkterm-test/RELEASE-v0.1.0.md.
  - 09269d6: Berechtigungsdialog auch im lokalen Browser unter Linux (Nutzertest im Testcontainer ok); Windows/WSL-Pfade: Eintrag deaktiviert.
  - Release v0.1.0 (Pre-release, privat) in werklade/werkterm mit .deb, AppImage und SHA256SUMS, vom Nutzer veröffentlicht 2026-11-08.
  - Offen: Tester einladen (Org-Rolle Read), Testcontainer löschen, Seriell-Berechtigungshilfe mit echtem Gerät unter Linux testen.
  - Nach 0.1.0: c8f761d (WindTerm-Meldungen), 9baaea6/c16df88 (Hardware-Ansicht hält Shell offen), d0a3d2f (Dotfile-Hervorhebung),
    cac7ff1 (Monitoring folgt dem angeklickten MultiExec-Terminal). Version 0.1.1, Pakete in WSL gebaut.
  - 0.1.2: Sitzungs-Export (alle / Auswahl / Ordner, ohne Passwörter, Format werkterm-sessions v1) und Werkterm-Import mit Vorschau,
    Duplikaterkennung, neuen IDs und Jump-Host-Umschreibung; Passwort-Sitzungen werden zu "Beim Verbinden fragen".
    Sessions-Menü: Aktionen oben, gespeicherte Sitzungen darunter.
    Designs (e90730d): alle Farben aus einem Design (UI, Terminal, Editor, Monitoring); Werklade Dunkel/Hell, Design-Reiter mit
    Editor, Kontrastwarnung, Export/Import (werkterm-design v1, config/designs). Icon-Sets: Standard, Werklade, Ordner-Import mit
    SVG-Allowlist-Bereinigung in Rust (config/icon-sets), Vorlagen-Export. Werklade-Set als Duotone: jedes Icon (außer Debian) mit
    class="wl-fill"-Fläche, offene Icons mit Unterlage; Session+ neu gezeichnet (Plus im Kreis). Tests: cargo Windows 170, Vitest 363/363. Tests: cargo Windows 160, Vitest 350/350.
  - Release v0.1.2 (Linux) vom Nutzer veröffentlicht 2026-11-08.
  - 0.1.3: Windows-Pakete (tauri.windows.conf.json: NSIS currentUser DE/EN, MSI en-US; unsigniert -> SmartScreen-Hinweis),
    Hardware-Übersicht unter Windows (hardware.ps1, powershell -NoExit -EncodedCommand, nur lesend), Icons mit Kreis-Plakette
    (+ / Pfeil) und Ring für Pfeil-Icons; Download/Upload behalten ihre gefüllten Schalen. CLAUDE.md: Windows ist Zielplattform.
  - Design-Repo werklade/design angelegt und nach GitHub (privat) gepusht; Ordnerumzug nach werklade/werkterm erledigt (2026-11-08).
    Werkterm: Werklade Dunkel/Hell werden direkt aus src/brand/werklade.tokens.json erzeugt (keine doppelten Farbwerte mehr).
    npm run sync-design kopiert Tokens und Icons (Herstellerlogos bleiben lokal), npm run check-design meldet Abweichungen ohne zu schreiben.
    Beenden-Icon: Ein/Aus-Symbol im getönten Ring (wie Aktualisieren), keine offene gefüllte Form mehr.
    Icons Home, MultiExec, Hilfe, Split, View, Beenden liegen jetzt im Design-Repo (cadb666) und als Dateien in src/assets/icons.
    Neues Werkterm-Logo (Entwurf C, Werklade-Produktraster) aus design/logo (459ede7): Startseite, App-Icons per tauri icon; altes app-icon.svg entfernt.
    Text auf Orange ist auch in Werklade Hell Schiefer (on-accent #1f2933, 4.51:1 statt Weiß 3.27:1). Neuer Token
    accent-hover-fill für den Primärknopf unter dem Zeiger (Hell #e07d22, 5.01:1); accent-hover bleibt Text-/Symbolfarbe.
    Eigene Designs ohne accent-hover-fill übernehmen ihren accent-hover; Rust-Validierung (designs.rs) kennt den Schlüssel.
  - Tests: Vitest 371/371, cargo test 173 ok. Hinweis: Nach größeren Frontend-Änderungen Dev-App komplett neu starten (Hot Reload übernahm Overlay-Änderungen nicht zuverlässig).
- 0.1.8-Vorbereitung (2026-11-10; erste Runde committet als b4ca83a, Version 0.1.8 gesetzt in dfa68d8, Testpakete in 8014f59 vermerkt; unveröffentlicht, CHANGELOG-Abschnitt Unreleased):
  - Einfügen-Dialog "Einfügen bestätigen": Auswahlliste "Auswahl merken?" (Nicht merken / Für diesen Tab / Für das Profil [gespeicherte Sitzung] /
    Dauerhaft). Gemerkt wird die Aktion (Einfügen / Als eine Zeile) samt "Letzten Zeilenumbruch entfernen". Inhalte mit Steuerzeichen fragen immer nach.
    Bei MultiExec gilt nur "Dauerhaft merken". Einstellungen zeigen den Stand, "Gemerkte Auswahl zurücksetzen".
  - Einfügen: Steuerzeichen U+0080–U+009F werden als Steuerzeichen erkannt.
  - npm run check-paths: prüft Release-Binärdateien auf Benutzerpfade des Build-Rechners; Release-Pakete enthalten keine Verzeichnispfade des
    Build-Rechners mehr (Quellpfade in der Programmdatei werden umgeschrieben).
  - Linux: Umgehung für schwarzes Fenster bei NVIDIA-Grafik mit proprietärem Treiber (WEBKIT_DISABLE_DMABUF_RENDERER=1, unter Wayland zusätzlich
    __NV_DISABLE_EXPLICIT_SYNC=1; nur bei erkannter Karte und ohne Nutzer-Variablen; nicht an Kindprozesse weitergegeben;
    WERKTERM_NO_WEBKIT_WORKAROUND=1 schaltet ab, WERKTERM_WEBKIT_WORKAROUND=1 erzwingt). Auf echter NVIDIA-Hardware noch nicht bestätigt (siehe Offen).
  - .deb: libdbus-1-3 als Abhängigkeit, xdg-utils als Empfehlung.
  - README (EN/DE): Abschnitt Darstellungsprobleme / schwarzes Fenster (Variablen, AppImage-Übergangslösung GST_PLUGIN_PATH_1_0), check-paths im Build-Abschnitt.
  - Tests: cargo Windows 186 (+1 ignoriert), Linux 192; Vitest 408 (+2 unter Windows übersprungene Symlink-Tests). Reviews: code-reviewer und Codex, keine hohen Befunde, mittlere behoben. Mindestanforderung Linux: glibc 2.39 (Debian 13 / Ubuntu 24.04), .deb verlangt libc6 (>= 2.39); Debian 12 wird nicht unterstützt (Entscheidung 2026-11-10).
  - Testpakete 0.1.8 gebaut (2026-11-10, Stand dfa68d8, kein Tag/Release): .deb 6,2 MiB, AppImage 81,0 MiB (WSL Ubuntu 24.04), NSIS 4,1 MiB, MSI 5,9 MiB (Windows, Build-Wrapper mit NSIS/MSI-Bundling bestätigt). npm run check-paths: 0 Treffer unter Linux und Windows, ebenso usr/bin/werkterm im entpackten AppImage. .deb: Depends libdbus-1-3, libc6 (>= 2.39), libwebkit2gtk-4.1-0, libgtk-3-0; Recommends gnome-keyring, fonts-noto-color-emoji, xdg-utils. Tests: cargo Windows 186 (+1 ignoriert), Vitest 408 (+2 übersprungen).
  - Datenordner wählbar (noch ohne Commit; umgesetzt und automatisch getestet, im laufenden Programm noch NICHT von Hand geprüft):
    - Erster Start: „Datenordner wählen“ (Standardordner oder eigener Ordner, z. B. vom Cloud-Client synchronisiert und von mehreren Geräten geteilt). Später unter
      Einstellungen > Datenordner; beim Wechsel Neustart, laufende Tunnel werden gestoppt, offene Verbindungen nach Rückfrage getrennt.
    - Im Datenordner: sessions.json, tunnels.json, macros.json, settings.json, designs/, icon-sets/. Lokal pro Gerät: Passwörter (Schlüsselbund), Zuletzt-verwendet-Liste,
      zuletzt offene Tabs, Editor-Cache, Logs samt Log-Ordner-Pfad, Fenster-/Spaltenbreiten.
    - Enthält der Ordner schon Werkterm-Daten, werden sie verwendet; sonst lassen sich die bisherigen Daten kopieren (nichts überschrieben, Quelle unverändert).
    - Nicht erreichbarer Ordner: Dialog (Erneut versuchen / Anderen Ordner wählen / Standardordner verwenden), bis dahin wird nichts geschrieben, kein stiller Rückfall.
    - Änderungen von außen werden beim Wechsel zurück ins Fenster erkannt und neu geladen. Einstellungen werden vor dem Speichern gegen die zuletzt gelesene Fassung geprüft;
      bei Abweichung werden nur die eigenen Änderungen über die neue Fassung gelegt. Einstellungen liegen jetzt in settings.json statt im Speicher der Webansicht (einmalige Übernahme).
    - Bekannte Grenze (README „Bekannte Einschränkungen“): gleichzeitiges Bearbeiten derselben Sitzung auf zwei Geräten – letzte gespeicherte Fassung gewinnt oder Konfliktkopie des Sync-Clients.
      Dateien unverschlüsselt, mit Hostnamen und Benutzernamen, ohne Passwörter.
    - Der Rust-Teil wurde zunächst an Codex vergeben; dessen Modul kompilierte nicht und wurde weitgehend neu geschrieben. Reviews (code-reviewer): nichts Hohes, vier mittlere Befunde
      (Überschreiben der Einstellungen ohne Abgleich, Aufräumen gegen halb synchronisierte Sitzungsdatei, gerätebezogener Log-Ordner in geteilter Datei, Reihenfolge beim Ordnerwechsel) behoben.
    - Windows: Speichern von Sitzungen/Tunneln/Makros/Einstellungen wiederholt den letzten Schritt kurz, wenn ein Sync-Client die Datei gerade gesperrt hält.
    - Tests Backend: cargo Windows 206 (+1 ignoriert), Linux 214 (+1 ignoriert). Vitest 495 (+2 unter Windows übersprungene Symlink-Tests).
    - Commit b412c33. Zweiter Testsatz 0.1.8 (2026-11-10) aus b412c33 unter logs/werkterm-test/0.1.8-build2/ (deb, AppImage, NSIS, MSI, SHA256SUMS); check-paths 0 Treffer auf beiden Plattformen; Desktop-Eintrag in .deb und AppImage mit StartupWMClass=werkterm. Start-Test unter WSLg: kein Absturz mit leerem Konfigurationsordner und mit nicht vorhandenem Datenordner, dabei keine Konfigurationsdatei angelegt. Oberfläche des Datenordners weiterhin nicht von Hand geprüft (Prüfliste PRUEFLISTE-DATENORDNER.md im selben Ordner). Erster Testsatz ohne Datenordner bleibt unter logs/werkterm-test/0.1.8/.
  - Linux/GNOME: Das laufende Fenster zeigte in der Leiste ein Zahnrad statt des Werkterm-Icons, ein angehefteter Starter wurde nicht als laufend erkannt. Der Desktop-Eintrag nennt jetzt
    die Fensterklasse (StartupWMClass=werkterm). Auf Debian 13 (GNOME) gemeldet; Korrektur noch nicht im Paket bestätigt.
  - Hardware-Test (Notebook mit NVIDIA RTX A2000, Linux Mint 22.3): 0.1.7 läuft sowohl mit nouveau als auch mit dem proprietären Treiber 595 (open kernel) ohne schwarzes Fenster –
    der Fehler ist dort NICHT nachgestellt. Gemeldet wurde er auf einem älteren Rechner mit NVIDIA-Grafik; Test von 0.1.8 dort steht aus (Anleitung
    logs/werkterm-test/0.1.8/TESTANLEITUNG-0.1.8.md, Prüfliste PRUEFLISTE-P16.md im selben Ordner). Folge: 0.1.8 setzt die Abhilfe bei jedem proprietären NVIDIA-Treiber, also auch dort,
    wo sie nicht nötig ist (kostet Renderleistung); nach dem Test ggf. auf Treiberversion/Kartengeneration eingrenzen.

## Offen
- Terminal-Zoom (2026-11-13): Strg+Mausrad/Zwei-Finger-Geste ändern die Schriftgröße des Tabs (Terminal, Editor), sonst wird der Seiten-Zoom unterbunden. Vitest 504 (+2 übersprungen). Zwei-Finger-Geste mit dem Testsatz 0.1.10 bestaetigt; keine Möglichkeit mehr, die gesamte Oberfläche zu vergrößern (Einstellung „Oberflächengröße“ erwägen).
- Gemeldet 2026-11-11, noch nicht nachgestellt: Unterstriche im Terminal unsichtbar (Debian 13/GNOME, Foto; Behelf Zeilenhöhe 1,2 ungetestet); Echo des SSH-PROMPT_COMMAND-Einzeilers bleibt auf AlmaLinux über drei Zeilen stehen (Prüfung dort frühestens KW 47). Oberfläche mischt Deutsch und Englisch -> Sprachpakete Etappen A–C umgesetzt, D offen (siehe In Arbeit). Paketinstaller: AppStream-Metainfo ab 0.1.10 im .deb, Screenshots und DEP-11 im Repo fehlen noch.
- Update-Kanal: Adresse pkg.werklade.de, Plan liegt vor; .deb über APT, AppImage/Windows über Tauri-Updater (nur manuell bzw. Opt-in), Build-Basis Ubuntu 24.04, Veröffentlichen als von Hand gestarteter CI-Ablauf.
- Ideen: Monitoring im lokalen Terminal; Zertifikatsverwaltung mit CSR-Erzeugung.
- Schwarzes Fenster beim Kollegen auch mit 0.1.8-build2 (2026-11-13, nur telefonisch): .deb schwarz, AppImage nur mit
  GST_PLUGIN_PATH_1_0 (bekannte Luecke: AppImage ohne GStreamer-Plugins, stuetzt bundleMediaFramework). Das .deb nutzt
  System-GStreamer, also andere Ursache: NVIDIA-Erkennung greift nicht (linux_graphics::proprietary_nvidia), DMABUF-
  Abschaltung reicht nicht oder System-WebKitGTK verhaelt sich anders als das gebuendelte. Rueckfrage: logs/werkterm-test/0.1.8-build2/RUECKFRAGE-SCHWARZES-FENSTER.md.
- Test auf echter NVIDIA-Hardware unter Wayland und X11 (Prüfliste folgt). Auf dem Notebook mit RTX A2000 nicht nachstellbar (siehe 0.1.8-Vorbereitung); offen ist der Test auf dem älteren, betroffenen Rechner.
- Datenordner im laufenden Programm testen: Ersteinrichtung, Wechsel, nicht erreichbarer Ordner, zwei Geräte mit echtem Cloud-Ordner, Netzlaufwerk/UNC unter Windows.
- Datenordner: Designs werden bei externen Änderungen nicht neu geladen; eine Teilkopie bleibt bei abgebrochenem Kopieren liegen.
- AppImage mit GStreamer-Plugins (bundleMediaFramework, c2c9013, Entscheidung 2026-11-13): CI installiert plugins-base/-good/-gl und
  prueft libgstapp/libgstopengl/AppRun-Hook im AppImage. Run 43486816319 gruen: 106 Plugins, gst-plugin-scanner dabei, AppImage 91 MB
  (vorher ~86 MB). In WSL gestartet: keine Meldung "appsink not found" mehr. Offen: Test beim Kollegen mit diesem AppImage.
- APT-Setup-Skript install/werklade-apt-setup.sh (aus packages e120f4f hierher verschoben, README verlinkt es): Fingerprint-Pruefung gegen echten und falschen Schluessel
  sowie --dry-run geprueft, shellcheck ohne Befund. Echtlauf als root noch offen. Bereitstellung nur im werkterm-Repo
  (Entscheidung 2026-11-13: kein Download vom CT, nicht am Release); Release-Text verweist auf den README-Abschnitt.
- Sprachen: Oberflaeche mischt Deutsch und Englisch (z. B. Menue "Help" mit deutschen Eintraegen); Sprachdateien + Sprachwahl offen.
- Geplant: Updates über APT-Repo und Updater (Prüfung manuell + Opt-in; Auslieferung über eigenen Server hinter vorhandenem Reverse Proxy; Repo für
  mehrere Werklade-Pakete ausgelegt). CLAUDE.md 3.C muss dafür ergänzt werden.
- "Für das Profil"-Zurücksetzen der gemerkten Einfüge-Auswahl fehlt im Sitzungsdialog (nur gesammelt in den Einstellungen).
- Phase 5 (ausgewählt 2026-11-07, "hoher Nutzen: alle"), auf der bestehenden SSH-Verbindung:
  - Remote-Monitoring-Leiste für den aktiven SSH-Tab: Host, CPU, RAM, Netz, Uptime, Benutzer, Partitionen.
  - MultiExec: Eingabe gleichzeitig an mehrere Tabs.
  - Terminal-Einstellungen: Farbschema (inkl. Import aus MobaXterm [Colors]), Schrift, Cursor, Scrollback.
- Zurückgestellt: Makros (Papierflieger-Panel), Tab ablösen, Popup-Konsole, Mosh/RDP/VNC.
  Nicht geplant: Master-Passwort (Keyring), X11/Cygwin (unter Linux vorhanden), Netzwerk-/Port-Scanner, Paketmitschnitt,
  Wake on LAN (vorerst nicht, Entscheidung 2026-11-07; widerspräche CLAUDE.md 3.C).

## Bekannte Fehler / Einschränkungen
- AppImage ohne GStreamer-Plugins: Bleibt das Fenster schwarz oder stürzt die Darstellung ab, half bei einem Test `GST_PLUGIN_PATH_1_0=/usr/lib/x86_64-linux-gnu/gstreamer-1.0`
  (Debian/Ubuntu-Pfad); Übergangslösung, siehe Offen.
- Ordner-Download und Ordner-Upload noch nicht möglich.
- Unix: Hält ein Hintergrundprozess den PTY-Slave offen, läuft der Reader-Thread nach Shell-Ende weiter.
  Fix: abbrechbares Lesen.
- Unix: `pty_kill` sendet nur SIGHUP; ignoriert die Shell das, läuft sie weiter. Fix: Prozessgruppe
  beenden, nach Frist SIGKILL.
- Hostkey: Hat known_hosts für einen Host nur Schlüssel eines ANDEREN Typs, wird das als "geändert"
  abgelehnt (strenger als OpenSSH). Abhilfe: alten Eintrag mit `ssh-keygen -R` entfernen.
- SSH-Einzeiler für OSC 7 funktioniert nur mit Bash auf dem Server; sein Echo ist einmal sichtbar.
- UNC-Pfade (\\server\share) im PowerShell-Tab: OSC 7 wird gesendet, lokales Listing nicht getestet.
- WSL-Tab startet die Standard-Distribution (`Ubuntu` 26.04), nicht Ubuntu-24.04.
- Vite-Warnung: Bundle > 500 kB (xterm); unkritisch, ggf. Code-Splitting in Phase 4.
- Windows: Nach einem Update mit neuem App-Icon zeigt die Taskleiste evtl. das alte Icon (Icon-Cache von Windows, gleicher Installationspfad). Abhilfe: `ie4uinit.exe -show`, sonst Explorer neu starten (`Stop-Process -Name explorer -Force`) oder ab- und anmelden. Gehört in jeden Release-Text mit Icon-Änderung.

## Nächster Schritt
- **Entscheidung 2026-11-13:** Die erste Version mit Sprachpaketen Deutsch/Englisch wird **1.0.0** (0.1.10 wird nicht veröffentlicht),
  und mit ihr wird das Repo werklade/werkterm öffentlich (normales Release statt Pre-release). Vorher: Befunde aus
  logs/public-audit-2026-11.md abarbeiten (erledigt 2026-11-14: STATUS.md bereinigt, prompts/ aus dem Repo genommen,
  alter Projektname entfernt; 2026-11-14 zweite Runde: CLAUDE.md aus dem Repo genommen (lokal, git-ignoriert), docs/release.md und
  release.yml ohne Hinweise auf den privaten Veröffentlichungsweg, READMEs ohne Vorabversion/Tester, versionsneutral; Version auf
  1.0.0 gesetzt (Metainfo type=development bis zum CHANGELOG-Abschnitt).
  2026-11-15: Neues Repo werklade/werkterm (vorerst privat) mit gefilterter Historie (git filter-repo: ohne prompts/, CLAUDE.md,
  AGENTS.md und alte STATUS.md-Fassungen; 147 Commits, Tags v0.1.0-v0.1.8 neu gesetzt). Das bisherige Repo heisst
  werklade/werkterm-archive (privat, alte Pre-releases). Sicherung aller Refs: Bundle ausserhalb des Repos. Lokaler und
  WSL-Klon umgestellt. Offen: Secrets TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) im neuen Repo (Nutzer), Release 1.0.0, dann public.
- **Übergabe 2026-11-13 (neue Sitzung beginnt hier).** Stand der Arbeit am Update-Kanal:
  - Werkterm: Update-Prüfung und Selbst-Update umgesetzt (Backend src-tauri/src/updater.rs über tauri-plugin-updater 2.14.1 mit rustls,
    Oberfläche src/components/UpdateDialog*, src/lib/update*.ts, Einstellung updateCheckOnStart). Öffentlicher Updater-Schlüssel steht in
    tauri.conf.json; der private Schlüssel liegt beim Nutzer (nie im Repo), wird als GitHub-Secret TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD)
    gebraucht. Lokale Builds ohne Schlüssel laufen weiter (ohne .sig). Reviews: nichts Hohes; mittlere Befunde behoben
    (Startprüfung nur aus geladener Datei, Windows-Neustartzwang nach gescheitertem Installer-Start, Download nur von pkg.werklade.de).
    NICHT getestet: echtes Update auf irgendeiner Plattform, Windows-Paketbau mit dem Plugin.
    Tests beim Commit: cargo Windows 223 (+1 ignoriert), Linux 232 (+1 ignoriert); Vitest 589 (+2 übersprungen); clippy ohne Warnung.
  - Neues Repo werklade/packages (privat, Ordner ../packages): Server-Konfiguration für pkg.werklade.de (reprepro, nginx-Container
    werklade-pkg), bin/werklade-publish (SSH-Forced-Command, 31 Tests),
    docs/einrichtung.md (11 Schritte), docs/betrieb.md, docs/publish-protokoll.md. Betriebsdetails des Servers stehen nur dort, nicht in diesem Repo.
  - Offen, in dieser Reihenfolge: (1) erledigt 2026-11-13: jq 1.7 und shellcheck 0.9.0 in WSL Ubuntu-24.04 installiert, tests/run.sh mit echtem jq 31/31 bestanden, shellcheck für bin/werklade-publish ohne Befund (packages 2. Commit); auf dem Server bleibt der Lauf mit echtem reprepro offen;
    (2) Einrichtung des Paket-Servers nach docs/einrichtung.md (Nutzer führt aus); (3) CI in werkterm:
    Ablauf 1 bei Tag (bauen Linux auf ubuntu-24.04 + Windows, check-paths, SHA256SUMS, latest.json nur mit linux-x86_64-appimage /
    windows-x86_64-nsis / windows-x86_64-msi, Release-Entwurf), Ablauf 2 von Hand (Veröffentlichen per SSH: erst deb, dann
    release-test bzw. release); (4) Testlauf 0.1.8 -> 0.1.9 über den Testkanal (WERKTERM_UPDATE_CHANNEL=test); (5) AppStream-Metadaten
    fürs .deb; (6) neues Testpaket bauen (enthält dann Zoom + Updater).
  - Weiter offen aus früheren Runden: Test beim Kollegen (schwarzes Fenster, logs/werkterm-test/0.1.8/TESTANLEITUNG-0.1.8.md),
    Datenordner von Hand prüfen (logs/werkterm-test/0.1.8-build2/PRUEFLISTE-DATENORDNER.md), Unterstriche im Terminal und
    PROMPT_COMMAND-Echo auf AlmaLinux (KW 47), Sprachpakete Deutsch/Englisch, Monitoring im lokalen Terminal, Zertifikatsverwaltung.
  - Stand 2026-11-13 nachmittags: Schritt (2) ERLEDIGT (packages a879b6b). https://pkg.werklade.de ist erreichbar,
    Repo-Schluessel ed25519 erzeugt, Testsuite auf dem Ziel 31/31 gruen, apt update von aussen getestet.
    Veroeffentlicht wird von Hand per SSH (kein Deploy-Schluessel in der CI); Deploy-Schluessel eingetragen,
    Schritt 11 (Forced Command) bestanden.
  - Stand 2026-11-13 abends: Schritt (3) ERLEDIGT (e3eb107, 935dca7). .github/workflows/release.yml (Tag v*.*.* oder
    von Hand): check (Versionen, tsc/Vitest, fmt/clippy/cargo test), Linux- und Windows-Build mit Updater-Signatur,
    Bundle-Artefakt werkterm-<v> (Pakete, .sig, SHA256SUMS ohne .deb, latest.json, release-<v>.tar, github/ mit
    SHA256SUMS inkl. .deb und RELEASE-TEXT.md), gegen die Server-Regeln geprueft. Veroeffentlichen vom PC:
    npm run publish-pkg -- <v> --channel test|stable --run <run-id> (SSH-Alias werklade-pkg). Ablauf: docs/release.md.
    Erster gruener Lauf: Actions-Run 43434006909 (0.1.8, nur gebaut, nicht veroeffentlicht). Dabei behoben: zeitabhaengige
    PTY-Tests (warten jetzt auf das Schliessen des Kanals). Nicht getestet: publish-pkg gegen den echten Server.
  - Stand 2026-11-13 spaetabends: Schritt (4) ERLEDIGT fuer Windows (NSIS). 0.1.8 (Run 43434006909) und 0.1.9 (Run
    43442409838, Branch test/update-0.1.9, Inhalt = 0.1.8) per publish-pkg im Testkanal; installierte 0.1.8 mit
    WERKTERM_UPDATE_CHANNEL=test hat ueber "Hilfe > Nach Updates suchen" auf 0.1.9 aktualisiert (Nutzer bestaetigt).
    Damit sind Signatur, Server, publish-pkg und Updater Ende zu Ende geprueft. Update per AppImage und MSI
    seit 2026-11-13 ebenfalls bestaetigt. Versionen: downloads/0.1.8 und 0.1.9 sind veroeffentlicht und unveraenderlich. 0.1.8 kann
    unveraendert stabil werden (publish-pkg 0.1.8 --channel stable --run 43434006909, dann deb ins APT); 0.1.9 ist als
    Testbau vergeben, die naechste echte Version nach 0.1.8 ist 0.1.10. Branch test/update-0.1.9 nicht mergen.
  - Stand 2026-11-13 nachts: Schritt (5) ERLEDIGT (2d0b02f, main jetzt 0.1.10). src-tauri/linux/de.werklade.werkterm.metainfo.xml
    wird per bundle.linux.deb.files nach /usr/share/metainfo installiert; CI prueft sie mit appstreamcli validate und
    kontrolliert den Inhalt des .deb; scripts/metainfo.test.mjs gleicht ID, Version, Desktop-Datei und CHANGELOG ab
    (oberster Release type="development", bis CHANGELOG einen Abschnitt fuer die Version hat). Run 43452071327 gruen;
    .deb 0.1.10 in WSL installiert, appstreamcli get de.werklade.werkterm zeigt Name, Kurzbeschreibung, Icon.
    Offen dazu: Screenshots und Homepage in der Metainfo, DEP-11-Daten im APT-Repo (sonst sieht das Software-Zentrum
    den Eintrag erst nach der Installation).
  - Stand 2026-11-13 nachts: Schritt (6) ERLEDIGT. Testsatz 0.1.10 (Commit 2d0b02f, Run 43452071327) liegt in
    logs/werkterm-test/0.1.10/ (AppImage, deb, NSIS, MSI, SHA256SUMS geprueft, BUILD.txt, PRUEFLISTE-0.1.10.md: Installation,
    Zoom, Update-Pruefung, AppStream). NICHT veroeffentlicht (0.1.10 bleibt erweiterbar). Der stabile Kanal ist leer
    (latest.json 404), die Update-Pruefung in 0.1.10 meldet dort einen Fehler, bis 0.1.8 stabil veroeffentlicht ist.
  - Stand 2026-11-13 18:12 UTC: 0.1.8 im Kanal stable veroeffentlicht (publish-pkg, Run 43434006909, gebaut aus 935dca7):
    updates/latest.json = 0.1.8, APT stable enthaelt werkterm 0.1.8, Downloads AppImage/NSIS/MSI von aussen 200.
  - GitHub-Pre-release v0.1.8 angelegt (Tag auf 935dca7, Dateien aus Run 43434006909, SHA256SUMS mit .deb); der vom Tag
    ausgeloeste Build 43481285964 wurde abgebrochen. READMEs auf 0.1.8 und das APT-Repo umgestellt (7cc79e8).
  - Pruefliste 0.1.10 (A Installation, B Zoom, C Update-Pruefung, D AppStream) vom Nutzer am 2026-11-13 als erfolgreich
    gemeldet. Der Update-Kanal (Uebergabe-Schritte 1-6) ist damit abgeschlossen.
  - AppImage-Update 0.1.8 -> 0.1.9 ueber den Testkanal in WSL Ubuntu-24.04 (WSLg) erfolgreich (2026-11-13, Nutzer bestaetigt):
    Datei an Ort und Stelle ersetzt, Name bleibt, Inhalt byteidentisch mit downloads/0.1.9, Ausfuehrungsrecht erhalten.
  - MSI-Update 0.1.8 -> 0.1.9 ueber den Testkanal auf Windows 11 erfolgreich (2026-11-13, Nutzer bestaetigt, Installationsliste
    und Dateiversion geprueft). Damit alle drei Updater-Wege (NSIS, MSI, AppImage) Ende zu Ende geprueft.
    Befund: Das MSI uebernimmt einen vorhandenen NSIS-Installationsordner (%LOCALAPPDATA%\Werkterm), ueberschreibt dessen
    werkterm.exe, beide Eintraege stehen dann in "Installierte Apps". Nie beide Arten auf einem Rechner; Hinweis in docs/release.md.
    Befund: Der Update-Dialog zeigt die Release-Notizen als Markdown-Rohtext (### Added, -); nur Darstellung.
  - Offen: Screenshots/Homepage in der Metainfo, DEP-11 im
    APT-Repo; geplanter Umzug des Paket-Servers (siehe Repo packages).
  - Arbeitsweise: Codex hat sich für Einbindungen in bestehende Rust-Dateien nicht bewährt (Sandbox-Schreibrechte, Modul kompilierte
    nicht) – nur als Zweit-Review einsetzen. Agents ohne Shell (ui-designer) liefern ungeprüften Code: tsc und Vitest danach selbst laufen lassen.
- 0.1.8 vorbereiten (Einträge unter Unreleased in CHANGELOG.md, siehe "In Arbeit"). Zuerst: Review-Fixes, Test auf echter NVIDIA-Hardware (Wayland, X11), Entscheidung zu GStreamer-Plugins im AppImage, Windows-Paketbau über den Build-Wrapper.
- 0.1.7 (OSC-7-Hook erbt nicht mehr in Kind-Shells wie pct enter) gebaut und als Pre-release v0.1.7 veröffentlicht (2026-11-08, Tag auf bb4b985); mit pct enter bestätigt. Unveröffentlicht: RAM-Anzeige der Monitor-Leiste in GiB/MiB statt dezimal GB/MB (passt jetzt zu Proxmox). Vor jedem Commit zusätzlich npm run check-design. Offen zum Design-Repo: theme.css-Grundwerte angleichen. Als Nächstes: Design-Editor (Farben, Icon-Sets, Werklade-Theme) planen. Danach: Tester einladen und Rückmeldungen sammeln; Seriell-Hilfe unter Linux mit echtem Gerät testen.
