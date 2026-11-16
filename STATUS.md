# STATUS – Werkterm

Stand: 2026-11-15

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
- Release-Notizen im Update-Dialog formatiert (eigener kleiner Markdown-Parser, ohne HTML, ohne Links); Issue-Vorlagen
  für Fehler und Funktionswünsche auf GitHub.

## In Arbeit
- Umzug des Paket-Servers pkg.werklade.de auf den endgültigen Server: am 2026-11-15 umgeschaltet und abgenommen
  (Downloads, APT, Update-Daten, Veröffentlichen). Veröffentlichen läuft wieder, auch im Testkanal (#16, #8).
  Offen: Beobachtungswoche bis 2026-11-22, danach den alten Server abbauen (Betriebshandbuch im privaten Repo
  `werklade/packages`).

## Offen
Geplantes und gemeldete Fehler stehen als GitHub-Issues (Meilenstein 1.1.0: #1–#6, #8; Sammelliste: #7, #9–#13).
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
- #2 schwarzes Fenster: Ursache gefunden, der Tester hat eine GTX 1060 mit nouveau (X11), und nouveau wurde nicht als
  NVIDIA-Fall erkannt; die Variable `WEBKIT_DISABLE_DMABUF_RENDERER=1` von Hand hilft (bestätigt, .deb und AppImage
  1.0.0). Fix unter #21 in Arbeit (Abhilfe auch bei nouveau); wartet auf Test mit neuem Build.
- #8 OSC-7-Echo und Historie: behoben auf main (Prompt-Erkennung, Selbstlöschung aus der Historie, Bash 5.2 geprüft);
  Test auf dem AlmaLinux-Ziel (Bash 4.4/5.1) steht aus, Label `testing`.
- Testkanal (2026-11-15): 1.0.1 (Branch test/1.0.1, Run 43666264597: #8, #17) und 1.0.2 (Branch test/1.0.2 = 1.0.1 + main
  bis 1fe4be1, Run 43680780421: zusätzlich #16) veröffentlicht. #17 unter Windows bestätigt (Update 1.0.1 -> 1.0.2 zeigt
  die Notizen formatiert). Offen: Einstellungsfenster in 1.0.2 (#16), #8 am AlmaLinux-Ziel. Versionen 1.0.1/1.0.2 sind vergeben; nächste echte
  Version 1.1.0 (oder 1.0.3). Test-Branches nicht mergen, nach den Tests löschen.
- #1 Sitzungsverwaltung per Drag & Drop.
- Release-Ablauf: `docs/release.md`.
