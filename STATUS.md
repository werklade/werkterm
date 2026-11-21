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
- Testbuild 1.2.5 (Branch test/1.2.5 = main bis 8d7ac43 plus Versionscommit, Run 44874675231, 2026-11-21) im
  Testkanal und in APT `test`, von außen geprüft; test/1.2.4 gelöscht. Enthält alles Folgende plus #11 (Ordner
  herunter-/hochladen). Test auf dem Mint-Notebook (X11 und Wayland) laut `werkterm-1.2.5-testliste.md`
  (Werklade-Ordner). Server-Download 1.2.4 nach Regel noch zu entfernen (nur durch den Nutzer). Testergebnis:
  #27, #6, #5, #25, #11 im Kern ok; daraus #28–#32.
- Testbuild 1.2.8 (Branch test/1.2.8 = main bis 16bddd2 plus Versionscommit, Run 44908837969, 2026-11-21) im
  Testkanal und in APT `test`, von außen geprüft; test/1.2.7 gelöscht. Server-Download 1.2.7 nach Regel noch zu
  entfernen (nur durch den Nutzer). Neu gegenüber 1.2.7: #34 Mehrfachauswahl im Dateibrowser. 1.2.7 brachte #33
  Umbenennen (Symbol `rename` aus werklade/design 425e18c), vom Nutzer bestätigt, ebenso #24; 1.2.6 brachte #1,
  #28–#31 (bestätigt). Nach dem Test von 1.2.8: Stable 1.3.0. Enthält zusätzlich zu 1.2.5:
- Seit 1.2.5 (alle `testing`): #1 Sitzungsliste ordnen (Ziehen, Verschieben,
  Umbenennen, leere Ordner, Rückgängig); #29 Abbrechen-Knopf und Fortschrittsbalken fest links; #30 Beschriftungen
  bei 150 %; #31 „Sitzung“ statt „Profil“; #28 Drop auf HiDPI unter Linux (Position war doppelt skaliert; unter
  Ubuntu 26.04 bestätigt). Cinnamon-Wayland liefert keine Drop-Ereignisse (README). Diagnose `WERKTERM_DEBUG_DND=1`.
  #32 (aus dem Browser herausziehen, im Browser verschieben) offen, ohne Meilenstein.
- 2026-11-21 auf main (alle `testing`, Rust-Tests auch in WSL grün):
  #15 Setup-Skript `--test` (geschlossen, Test über #26); #3 Designs und Icon-Sets nach externen Änderungen neu
  laden; #4 Teilkopie beim gescheiterten Datenordner-Wechsel zurückbauen; #5 gemerkte Einfüge-Auswahl je Sitzung
  zurücksetzen; #6 Oberflächengröße 90–150 % (je Gerät, Webview-Zoom); #27 Touchpad-Pinch unter Linux zoomt die
  Terminal-Schrift statt der ganzen Oberfläche (WebKit-Geste per internem Schlüssel abgeschaltet, eigene Geste).
  Offen: Sichtprüfung in der App; #27 nur auf echtem Linux-Touchpad prüfbar.
- #7 (Unterstriche): Anleitung `werkterm-1.2.4-unterstriche-1.md` (Werklade-Ordner, nicht im Repo) an den Tester;
  wartet auf Ergebnisse.
- Umzug des Paket-Servers pkg.werklade.de auf den endgültigen Server: am 2026-11-15 umgeschaltet und abgenommen
  (Downloads, APT, Update-Daten, Veröffentlichen). Veröffentlichen läuft wieder, auch im Testkanal (#16, #8).
  Offen: Beobachtungswoche bis 2026-11-22, danach den alten Server abbauen (Betriebshandbuch im privaten Repo
  `werklade/packages`).

## Offen
Geplantes und gemeldete Fehler stehen als GitHub-Issues (Meilenstein 1.2.0: nur #14; Meilenstein 1.3.0: #1, #3–#6, #11, #20, #23–#27; Sammelliste: #7–#10, #12, #13, #19).
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
