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

## In Arbeit
nichts

## Offen
- Tests von außen:
  - Schwarzes Fenster mit dem .deb auf dem Rechner eines Testers. Ursache offen: NVIDIA-Erkennung in
    `linux_graphics::proprietary_nvidia`, DMABUF-Abschaltung reicht nicht, oder System-WebKitGTK. 1.0.0 dort testen;
    das AppImage sollte dank GStreamer-Plugins ohne Variable laufen.
  - Abhilfe auf echter NVIDIA-Hardware (Wayland, X11) bestätigen, ggf. auf Treiber/Kartengeneration eingrenzen.
  - Setup-Skript `install/werklade-apt-setup.sh` als root auf frischem System.
- Von Hand prüfen:
  - Datenordner: Ersteinrichtung, Wechsel, nicht erreichbarer Ordner, zwei Geräte mit Cloud-Ordner, Netzlaufwerk/UNC
    unter Windows.
  - Gemeldet, nicht nachgestellt: Unterstriche im Terminal unsichtbar (Debian 13/GNOME); Echo des
    PROMPT_COMMAND-Einzeilers auf AlmaLinux.
  - Rückfrage beim Schließen des Fensters.
  - Seriell-Berechtigungshilfe (Linux) mit echtem Gerät.
- Kleine Fehler/Lücken:
  - Update-Dialog zeigt Release-Notizen als Markdown-Rohtext.
  - Designs werden bei externen Änderungen nicht neu geladen.
  - Abgebrochenes Kopieren in den Datenordner hinterlässt eine Teilkopie.
  - „Für das Profil“-Zurücksetzen der Einfüge-Auswahl fehlt im Sitzungsdialog (nur gesammelt in den Einstellungen).
  - Sprachwechsel des Systems zur Laufzeit wird nicht übernommen.
  - Keine Möglichkeit, die gesamte Oberfläche zu vergrößern (Einstellung „Oberflächengröße“ erwägen).
- Infrastruktur/Verteilung:
  - Paket-Server pkg.werklade.de auf den endgültigen Server umziehen (Betriebshandbuch im privaten Repo
    `werklade/packages`).
  - Screenshots in der AppStream-Metainfo.
  - DEP-11-Daten im APT-Repo (sonst zeigt das Software-Zentrum den Eintrag erst nach der Installation).
- Ideen: Monitoring im lokalen Terminal; Zertifikatsverwaltung mit CSR-Erzeugung.
  Zurückgestellt: Tab ablösen, Popup-Konsole, Mosh/RDP/VNC, Ordner-Download/-Upload.
  Nicht geplant: Master-Passwort, X11/Cygwin, Port-Scanner, Paketmitschnitt, Wake on LAN.

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
- Rückmeldung des Testers zum schwarzen Fenster mit 1.0.0 einholen (.deb und AppImage).
- Datenordner von Hand prüfen.
- Markdown der Release-Notizen im Update-Dialog darstellen.
- Paket-Server auf den endgültigen Server umziehen.
- Release-Ablauf: `docs/release.md`.
