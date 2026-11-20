# STATUS – Werkterm

Stand: 2026-11-20

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
- Release-Notizen im Update-Dialog formatiert (eigener kleiner Markdown-Parser, ohne HTML, ohne Links); Issue-Vorlagen
  für Fehler und Funktionswünsche auf GitHub.

## In Arbeit
- #23 (eigene SSH-Optionen `-o`): committet; offen: Test gegen einen alten Server, Linux-Lauf in WSL.
- Umzug des Paket-Servers pkg.werklade.de auf den endgültigen Server: am 2026-11-15 umgeschaltet und abgenommen
  (Downloads, APT, Update-Daten, Veröffentlichen). Veröffentlichen läuft wieder, auch im Testkanal (#16, #8).
  Offen: Beobachtungswoche bis 2026-11-22, danach den alten Server abbauen (Betriebshandbuch im privaten Repo
  `werklade/packages`).

## Offen
Geplantes und gemeldete Fehler stehen als GitHub-Issues (Meilenstein 1.2.0: nur #14; Meilenstein 1.3.0: #1, #3–#6, #11, #15, #20, #23–#25; Sammelliste: #7–#10, #12, #13, #19).
Hier nur, was nicht öffentlich geführt wird:
- Setup-Skript `install/werklade-apt-setup.sh` als root auf frischem System testen.
- Von Hand prüfen: Datenordner (Ersteinrichtung, Wechsel, nicht erreichbar, zwei Geräte mit Cloud-Ordner, UNC unter
  Windows); Rückfrage beim Schließen des Fensters; Seriell-Berechtigungshilfe (Linux) mit echtem Gerät.
- Zurückgestellt: Tab ablösen, Popup-Konsole, Mosh/RDP/VNC. Nicht geplant: Master-Passwort, X11/Cygwin, Port-Scanner,
  Paketmitschnitt, Wake on LAN.

## Bekannte Fehler / Einschränkungen
- Hostkey: Hat known_hosts für einen Host nur Schlüssel eines anderen Typs, wird das als „geändert“ abgelehnt
  (strenger als OpenSSH). Abhilfe: alten Eintrag mit `ssh-keygen -R` entfernen.
- Der SSH-Einzeiler für OSC 7 funktioniert nur mit Bash auf dem Server; sein Echo ist einmal sichtbar.
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
  Testbuilds 1.0.1–1.0.3 liegen noch unter Downloads auf dem Server (Entfernen nur per Forced Command laut
  Betriebshandbuch).
- Weiter laut Nutzer: #25 (drei Retro-Designs; Entwürfe `tmp/retro-designs-preview.html` warten auf Abnahme).
- Im Meilenstein 1.1.0 ist nur noch #22 offen (ausgeliefert, wartet auf Bestätigung).
- #22 (Meldung ohne grafische Sitzung): in WSL geprüft, beim Tester mit 1.1.0 noch zu bestätigen, Label `testing`.
- #8 OSC-7-Echo: Fix in 1.1.0 (Bash 5.2 geprüft), Test mit Bash 4.4/5.1 offen; zurückgestellt, `prio:P3`.
- nouveau unter Wayland ungetestet.
- Testkanal: Versionen 1.0.1–1.0.3 sind vergeben; ihre Branches sind nach dem Release 1.1.0 gelöscht. Regel: Nach
  einem Stable-Release fallen ältere Test-Builds weg, von Tests bleibt nur der neueste; Stable-Releases bleiben immer.
- Als Nächstes in der Entwicklung: #7 (Unterstriche unsichtbar), #20 (Einfüge-Dialog), #4 und #3 (Datenordner).
- Release-Ablauf: `docs/release.md`.
