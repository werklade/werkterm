# STATUS – Werkterm

Stand: 2026-11-24

Einzelheiten stehen in der Git-Historie und im CHANGELOG.

## Erledigt
- Terminals: lokal (PowerShell bzw. `$SHELL`, WSL-Tab), SSH, Telnet, seriell; Split-Ansicht (1/2/4), MultiExec,
  Sitzungs-Logging, Terminal-Kontextmenü, Einfügen mit Rückfrage (Auswahl merkbar: Tab, Profil, dauerhaft),
  Terminal-Zoom (Strg+Mausrad, Zwei-Finger-Geste).
- SSH (russh, russh-sftp): eine Verbindung mit Shell- und SFTP-Kanal, Exec-Fallback ohne SFTP, Hostkey-Prüfung gegen
  known_hosts, Agent/Schlüssel/Passwort, Passwörter nur im OS-Schlüsselbund, Sprungserver (bis 5 Hops), Tunnel-Manager
  (-L/-R/SOCKS5), Monitoring-Leiste.
- SFTP-Browser: folgt OSC 7, Download/Upload mit Warteschlange, Neu/Löschen, chmod (rekursiv), sudo-Modus.
- Editor (CodeMirror 6): Farbcode-Hinterlegung, Zeilenenden-Umschalter, BOM-/Kodierungserhalt, Konfliktschutz,
  Dateien und Ordner vergleichen.
- Sitzungen: Ordnerbaum, Mehrfachauswahl, Import aus MobaXterm und WindTerm, Export/Import als werkterm-sessions v1.
- Makros: Aufnahme, Editor, Abspielen, Tastenkürzel.
- Designs und Icon-Sets (Werklade Dunkel/Hell, Editor, Export/Import, bereinigter SVG-Import); Quelle: Repo
  `werklade/design`.
- Datenordner wählbar (auch Cloud-Ordner): Sitzungen, Tunnel, Makros, Einstellungen, Designs, Icon-Sets;
  Passwörter und Cache bleiben lokal.
- Sprachpakete Deutsch und Englisch (Etappen A–D): eigenes Lookup `src/i18n/`, Backend-Meldungen als `ui_error`-Codes.
- Update-Prüfung (Hilfe > Nach Updates suchen, optional beim Start) und Selbst-Update über tauri-plugin-updater gegen
  pkg.werklade.de; NSIS, MSI und AppImage Ende zu Ende getestet.
- Verteilung: APT-Repo, `install/werklade-apt-setup.sh`, AppStream-Metainfo im .deb, AppImage mit GStreamer-Plugins
  (kein `GST_PLUGIN_PATH_1_0` mehr nötig), Release-Ablauf per CI.
- Releases: 0.1.0–0.1.8 als Pre-releases im archivierten Repo; 1.0.0 am 2026-11-15 als erstes öffentliches Release.
  Das Repo `werklade/werkterm` ist seit 2026-11-15 öffentlich (bereinigte Historie); Rulesets schützen `main` und die
  Tags `v*`.
- 1.1.0 (2026-11-16, stable): schwarzes Fenster mit nouveau behoben (#2, #21, vom Tester mit 1.0.3 bestätigt, .deb und
  AppImage), Einstellungen mit vertikalen Tabs (#16), formatierte Release-Notizen (#17), klare Meldung ohne grafische
  Sitzung (#22), OSC-7-Echo (#8).
- 1.3.0 (2026-11-21, stable, Run 44910780684): Sitzungsliste ordnen (#1), Designs/Icon-Sets neu laden (#3), Teilkopie
  zurückbauen (#4), Einfüge-Auswahl je Sitzung (#5), Oberflächengröße (#6), Ordner übertragen (#11), Enter im
  Einfüge-Dialog (#20), SSH-Optionen (#23), Hinweise nach Zeitüberschreitung (#24), Retro-Designs (#25), APT-Testkanal
  (#15/#26), Pinch unter Linux (#27), Drop auf HiDPI (#28), Transferleiste (#29), Beschriftungen bei 150 % (#30),
  „Sitzung“ im Einfüge-Dialog (#31), Umbenennen (#33), Mehrfachauswahl (#34). Testbuilds 1.2.1–1.2.8 vorab;
  Server-Sicherung vor dem Release (`werklade-pkg-2026-11-21-1.3.0.tar.gpg`). Bestätigte Issues geschlossen; GitHub-Release v1.3.0 (Latest) angelegt, Anhänge per sha256sum geprüft.
- Release-Notizen im Update-Dialog formatiert (eigener kleiner Markdown-Parser, ohne HTML, ohne Links); Issue-Vorlagen
  für Fehler und Funktionswünsche auf GitHub.

## In Arbeit
- #35 ("SSH-Vorgang fehlgeschlagen: Failure: Failure" kurz nach dem Verbinden, Neu laden hilft): offen.
- #7 (Unterstriche): Ursache bestätigt (Mint 22.3, 1.3.0: bei Zeilenhöhe 1 unsichtbar, bei 1.2 sichtbar), xterm.js
  #4067 – der DOM-Renderer schneidet jede Zeile ab, DejaVu Sans Mono zeichnet `_` unter die Zelle. Fix auf `main`
  (Zeilen dürfen nach unten überstehen, `src/App.css`); vom Tester mit 1.3.1 bestätigt, geschlossen.
- #36 (OSC-7-Einzeiler nur nach Bash-Abfrage) und #37 (richtige Option in der Meldung): vom Tester mit 1.3.1
  bestätigt, geschlossen; ausgeliefert mit dem nächsten Release. #8 bleibt `testing` (AlmaLinux/Appliance-Probe offen).
- #38 (AppImage: lokale Shells erben `LD_LIBRARY_PATH` usw. des AppImage-Starters, `findmnt`/`eza` scheitern unter
  CachyOS): Fix auf `main` in `src-tauri/src/child_env.rs` – Kindprozesse bekommen die Umgebung ohne AppImage-Einträge,
  eigene Einträge bleiben in ihrer Reihenfolge; auch für entpackte AppImages. Unit-Tests plus Test mit echtem
  Kindprozess; in WSL gegen die echte AppRun-Umgebung eines laufenden AppImages geprüft. In Testbuild 1.3.2, wartet auf
  Bestätigung auf CachyOS.
- Testbuild 1.3.1 (2026-11-23, #7, #36, #8, #37): Tester 2026-11-24: Gerät ohne Bash, Bash-Gegenprobe,
  SSH-Optionsmeldung und Unterstriche ok; AlmaLinux/Appliance (#8) noch ohne Ergebnis. Abgelöst durch 1.3.2;
  Branch test/1.3.1 gelöscht, Server-Ordner `downloads/1.3.1` entfernt und gesperrt (2026-11-24).
- Testbuild 1.3.2 (Branch test/1.3.2 = main bis 0d25af7 plus Versionscommit, Run 45357463479, 2026-11-24, alle Jobs
  grün): enthält #38 und alles aus 1.3.1. Am 2026-11-24 im Testkanal und in APT `test` veröffentlicht, von außen
  geprüft (updates-test/latest.json byte-gleich, AppImage/EXE/MSI und .deb aus dem APT-Pool gegen die Prüfsummen
  des Artefakts). Wartet auf Rückmeldung des Testers.
- Umzug des Paket-Servers pkg.werklade.de auf den endgültigen Server: am 2026-11-15 umgeschaltet und abgenommen
  (Downloads, APT, Update-Daten, Veröffentlichen). Veröffentlichen läuft wieder, auch im Testkanal (#16, #8).
  Offen: Beobachtungswoche bis 2026-11-22, danach den alten Server abbauen (Betriebshandbuch im privaten Repo
  `werklade/packages`).

## Offen
Geplantes und gemeldete Fehler stehen als GitHub-Issues (ohne Meilenstein: #8–#10, #12, #13, #19, #32, #35, #38).
Hier nur, was nicht öffentlich geführt wird:
- Setup-Skript `install/werklade-apt-setup.sh` als root auf frischem System testen.
- Von Hand prüfen: Datenordner (Ersteinrichtung, Wechsel, nicht erreichbar, zwei Geräte mit Cloud-Ordner, UNC unter
  Windows); Rückfrage beim Schließen des Fensters; Seriell-Berechtigungshilfe (Linux) mit echtem Gerät.
- Zurückgestellt: Tab ablösen, Popup-Konsole, Mosh/RDP/VNC. Nicht geplant: Master-Passwort, X11/Cygwin, Port-Scanner,
  Paketmitschnitt, Wake on LAN.

## Bekannte Fehler / Einschränkungen
- Hostkey: Hat known_hosts für einen Host nur Schlüssel eines anderen Typs, wird das als „geändert“ abgelehnt
  (strenger als OpenSSH). Abhilfe: alten Eintrag mit `ssh-keygen -R` entfernen.
- Der SSH-Einzeiler für OSC 7 funktioniert nur mit Bash auf dem Server (wird nur nach erfolgreicher Bash-Abfrage
  gesendet, #36); sein Echo ist einmal sichtbar.
- UNC-Pfade (`\\server\share`) im PowerShell-Tab: OSC 7 wird gesendet, lokales Listing nicht getestet.
- Der WSL-Tab startet die Standard-Distribution, nicht eine wählbare.
- Vite-Warnung: Bundle > 500 kB (xterm); unkritisch.
- Windows: NSIS und MSI nicht auf einem Rechner mischen; das MSI übernimmt den NSIS-Installationsordner und
  überschreibt dessen `werkterm.exe`, beide Einträge stehen dann in „Installierte Apps“.
- Windows: Nach einem Update mit neuem App-Icon zeigt die Taskleiste evtl. das alte Icon (Icon-Cache). Abhilfe:
  `ie4uinit.exe -show`, sonst Explorer neu starten oder ab- und anmelden. Gehört in jeden Release-Text mit
  Icon-Änderung.

## Nächster Schritt
- Release 1.2.0 (#14 Update-Kanal) am 2026-11-20 veröffentlicht: CI-Lauf 44736285252, pkg.werklade.de test und
  stable, APT; ausgelieferte Dateien von außen gegen das CI-Artefakt geprüft. Vorher Server-Sicherung (Handbuch
  Abschnitt 1) lokal verschlüsselt abgelegt, nicht auf dem VPS. GitHub-Release v1.2.0 (Latest) angelegt. Offen:
  echter Update-Test 1.1.0 -> 1.2.0 und Rückwechsel Test -> Stable (Downgrade) unter NSIS/MSI/AppImage; #14 steht
  auf `testing`.
- Testbuild 1.2.1 (Branch test/1.2.1 = main bis 67d4eb9 plus Versionscommit, Run 44747338745) am 2026-11-20 im
  Testkanal, von außen geprüft. Enthält #20 (Enter im Einfüge-Dialog), #23 (eigene SSH-Optionen `-o`), #24
  (Hinweise nach Zeitüberschreitung), alle `testing`. Test-Branch nicht mergen, nach den Tests löschen.
- Testbuild 1.2.2 (Branch test/1.2.2 = main bis 56d0cbd plus Versionscommit, Run 44789860229) am 2026-11-20 im
  Testkanal und erstmals in APT `test`, von außen geprüft (latest.json, AppImage, NSIS, MSI, .deb-Prüfsumme).
  Enthält zusätzlich #25 und #26. Ersetzt 1.2.1 als Testbuild; Branch test/1.2.1 und Download 1.2.1 können weg.
- Testbuild 1.2.3 (Branch test/1.2.3 = main bis 366f35e plus Versionscommit, Run 44805811326, Versuch 2 nach
  hängendem Ubuntu-Spiegel) am 2026-11-20 im Testkanal und in APT `test`, von außen geprüft. Enthält das
  eigenständige Retro-Verhalten (#25). Ersetzt 1.2.2.
- Server-Downloads aufgeräumt (2026-11-20, neue Regel: aktuelle stabile, vorherige stabile, neuester Test):
  bleiben 1.1.0, 1.2.0, 1.2.3; 0.1.8–1.0.3, 1.2.1, 1.2.2 entfernt und in `withdrawn` gesperrt; Test-Branches
  1.2.1 und 1.2.2 gelöscht.
- #26 APT-Test-Kanal: Server am 2026-11-20 ausgerollt (APT-Distribution `test`, Forced Command `deb-test`,
  Sicherungen `*.bak-2026-11-20-1718` auf dem VPS); 1.2.1-.deb liegt in `test`, APT wählt bei `Suites: stable test`
  1.2.1 (in WSL mit isolierter APT-Konfiguration geprüft, nichts installiert). App-Hinweis mit Befehlen und
  `publish-pkg` (Kanal test lädt das .deb per `deb-test`) committet, kommt mit dem nächsten Testbuild.
- #25 (drei Retro-Designs): nach Rückmeldung zu 1.2.2 eigenständiges Verhalten je Design statt der normalen
  Tux-Simulation (Vorschau `tmp/retro-behaviour-preview.html` abgenommen), committet, Tests grün, kommt mit 1.2.3.
  Offen: Sichtprüfung in der laufenden App (Windows und Linux); Kopien eines Retro-Designs bekommen keinen Retro-Tux;
  Tux-Anzahl aus den Einstellungen wirkt in Retro-Designs nicht.
  v3 (Vorschau `tmp/retro-behaviour-preview-v3.html` abgenommen) im Testbuild 1.2.4 (Branch test/1.2.4 = main bis
  5b93c33 plus Versionscommit, Run 44827585454, 2026-11-20, Testkanal und APT `test`, von außen geprüft): Ebenen über
  2 Zeilen (Gerüst, Hüpfer-Bricks, Lemminge-Erdreich mit Stahl), drei Grabarten, Kletterer, eigener Abgang je
  Design bei Aktivität (< 1 s). Zeichnen und Abgangsphase ohne automatische Tests.
- Im Meilenstein 1.1.0 ist nur noch #22 offen (ausgeliefert, wartet auf Bestätigung).
- #22 (Meldung ohne grafische Sitzung): in WSL geprüft, beim Tester mit 1.1.0 noch zu bestätigen, Label `testing`.
- #8 OSC-7-Echo: Fix in 1.1.0 (Bash 5.2 geprüft), Test mit Bash 4.4/5.1 offen; zurückgestellt, `prio:P3`.
- nouveau unter Wayland ungetestet.
- Testkanal: Versionen 1.0.1–1.0.3 sind vergeben; ihre Branches sind nach dem Release 1.1.0 gelöscht. Regel: Nach
  einem Stable-Release fallen ältere Test-Builds weg, von Tests bleibt nur der neueste; Stable-Releases bleiben immer.
- Als Nächstes in der Entwicklung: #7 (Unterstriche unsichtbar), #20 (Einfüge-Dialog), #4 und #3 (Datenordner).
- Release-Ablauf: `docs/release.md`.
