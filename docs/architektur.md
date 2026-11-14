# Architektur von Werkterm

Diese Beschreibung bezieht sich auf den Quellstand von Version 0.1.0. Zielplattform ist Linux; Windows und WSL dienen auch der Entwicklung und Prüfung. Das Backend verwendet Rust Edition 2024 und Tauri 2, das Frontend React und TypeScript (`~6.0.3`). Maßgeblich sind `src-tauri/Cargo.toml`, `package.json` und die Lockdateien.

## Prozesse und Kommunikation

Tauri verbindet den nativen Rust-Anwendungsprozess mit dem WebView-Frontend. Lokale Shells sind eigene Kindprozesse an einem PTY; entfernte SSH-Shells laufen auf dem Zielserver. SSH und SFTP werden durch Rust-Bibliotheken abgewickelt, nicht durch einen externen SSH-Client. Linux verwendet WebKitGTK, die Windows-Entwicklungsfassung die dortige Tauri-WebView.

`src-tauri/src/main.rs` startet die Anwendung. `lib.rs` registriert Commands, Plugins und verwaltete Zustände, migriert beim Start Sitzungseinstellungen und initialisiert den Editor-Cache. Beim Beenden werden unter anderem Tunnel, Telnet/Seriell, Protokollschreiber und Editor-Cache aufgeräumt.

Das Frontend ruft Commands über die Tauri-API auf. Tauri-Channels übertragen Terminalbytes und Transferfortschritt; diese Daten werden nicht durch wiederholtes Abfragen einzelner Zeichen transportiert. Asynchrone SSH-Arbeit läuft mit Tokio; lokale PTY-Arbeit und Sitzungsprotokollierung nutzen außerdem eigene Threads.

## Backend-Module

Alle folgenden Pfade liegen unter `src-tauri/src/`:

| Modul | Aufgabe |
| --- | --- |
| `commands.rs` | Tauri-Schnittstellen für Terminals, SSH, Dateibrowser und Dialogantworten |
| `pty.rs` | Lokale Shells, PTY-Lesen/Schreiben, Größe und Beendigung |
| `ssh/mod.rs` | Transport, Hostkeys, Anmeldung, Jump hosts, Shell-Pump, SFTP und exec-Listing |
| `ssh/actions.rs` | Dateiaktionen und gestreamte, abbrechbare Transfers |
| `ssh/lsparse.rs` | Auswertung des exec-Listing-Fallbacks |
| `ssh/permissions.rs`, `ssh/sudo.rs` | Rekursives chmod und erhöhter SFTP-Kanal |
| `ssh/monitor.rs` | Remote-Monitoring über exec |
| `editor/mod.rs` | Dokumente, UTF-8/EOL/BOM, Konflikte, Speichern und Cache |
| `sessions/` | Sitzungen, Import aus MobaXterm/WindTerm, zuletzt verwendete und letzte Tabs |
| `secrets.rs` | Schlüsselbundzugriff, Fehlerkategorien und Übernahme alter Einträge |
| `tunnels/mod.rs` | Persistente Tunneldefinitionen, Hintergrundverbindungen und Weiterleitungen |
| `telnet.rs`, `serial.rs`, `serial_permission.rs` | Telnet, serielle Geräte und Linux-Berechtigungshilfe |
| `local_fs.rs`, `folder_diff.rs` | Lokale Dateizugriffe und rekursiver Ordnervergleich |
| `macros.rs`, `session_log.rs` | Makropersistenz und Terminalprotokolle |
| `keygen.rs`, `local_ports.rs`, `terminal_colors.rs` | Schlüssel erzeugen, lokale Ports anzeigen, Farben importieren |

## Frontend

`src/main.tsx` startet React; `src/App.tsx` koordiniert Tabs, Dialoge und gemeinsame Zustände. `src/components/` enthält unter anderem `TerminalView`, `FileBrowser`, `EditorView`, `SplitLayout`, Sitzungs-/Tunnel-/Makrodialoge, Monitoring, Datei-/Ordnervergleich und `TuxOverlay`.

`src/lib/` enthält Tauri-Adapter und getrennte Logik für OSC 7, Prompt-Hooks, Transfers/Warteschlange, MultiExec, Makros, Terminalexport, Einstellungen, Editor-Zeilenenden, Syntaxauswahl und Farbkontrast. xterm.js stellt die Terminals dar; CodeMirror 6 den Editor und `@codemirror/merge` den schreibgeschützten Dateivergleich. Syntaxunterstützung wird bedarfsweise geladen. Die Tux-Animation zeichnet eine Überlagerung; sie verändert den Terminalpuffer nicht.

## SSH-Verbindungsaufbau

1. Ziel und gegebenenfalls Jump-host-Kette auflösen. Jeder Hop erhält eigene Hostkey-Prüfung und Anmeldung; Zyklenschutz verhindert ungültige Ketten.
2. Hostkey gegen `known_hosts` prüfen. Unbekannt: Dialog mit SHA256-Fingerprint. Geändert: Abbruch. Ein ausschließlich unter einem anderen Schlüsseltyp vorhandener Host gilt ebenfalls als geändert.
3. Anmeldung: Agent wird vor der gewählten Methode versucht; anschließend Schlüssel beziehungsweise Passwort entsprechend den Einstellungen. Schlüssel können eine Passphrase benötigen; `.ppk` wird unterstützt.
4. Session-Kanal öffnen, Reader/Writer trennen und den unabhängigen Terminal-Pump sofort starten, noch vor den PTY-/Shell-Anfragen. Der Pump verarbeitet Daten und leitet Kanalantworten an den Aufbau weiter.
5. PTY anfordern, Shell starten und erst danach das SFTP-Subsystem auf einem zweiten Session-Kanal derselben Verbindung öffnen. Die Shell erhält so den ersten Session-Kanal, damit PAM-MOTD und aktuelle Login-Meldungen erscheinen können.
6. Der Pump leert bereits während der SFTP-Aushandlung den Terminalkanal. Umfangreiche Login-Ausgabe kann deshalb nicht den begrenzten Kanalpuffer und damit den SSH-Ereignisablauf blockieren. Ein Test bildet diesen Deadlock-Fall nach.
7. Ist SFTP nicht verfügbar, bleibt die Shell nutzbar; Verzeichnislisten verwenden einen exec-Fallback mit GNU-kompatiblem `ls`. Datei-Schreibaktionen und Transfers benötigen SFTP.

Aufbauphasen haben Zeitlimits und lassen sich beim Schließen abbrechen; Dialogwartezeit wird gesondert behandelt. Keepalive ist pro Sitzung konfigurierbar. Monitoring nutzt einen zusätzlichen exec-Kanal. Ordnervergleich und sudo können weitere Kanäle derselben authentifizierten Verbindung öffnen. Tunnel verwenden eigene Hintergrundverbindungen und unterstützen lokale/entfernte Weiterleitung und SOCKS5 mit Loopback als Standardbindung.

## OSC 7 und Verzeichnisverfolgung

`src/lib/osc7.ts` wertet `file://`-Angaben aus, dekodiert Pfade und berücksichtigt lokale Windows-Laufwerke beziehungsweise UNC-Pfade. `TerminalView` verbindet die OSC-7-Verarbeitung mit dem Verzeichnis des aktiven Tabs. Die Verfolgung ist abschaltbar.

Lokale PowerShell- und Bash-/WSL-Sitzungen bekommen Prompt-Integration. Für entfernte Bash ist ein optionaler Einzeiler in `src/lib/promptCommand.ts` implementiert: Er erweitert `PROMPT_COMMAND`, kodiert den aktuellen Pfad byteweise als URI und sendet OSC 7. Er ändert keine Shell-Konfigurationsdatei auf dem Server. Der Sender wartet auf Login-Ausgabe und einen ruhigen Prompt beziehungsweise eine begrenzte Wartezeit; das Echo des Einzeilers wird anschließend gelöscht. Andere entfernte Shells brauchen eigene OSC-7-Hooks.

## Transfers und Warteschlange

`src/lib/transferQueue.ts` implementiert eine serielle Warteschlange mit einer Lebensdauer unabhängig vom sichtbaren Browser. Tab-/Panelwechsel unterbrechen sie nicht. Beim Schließen einer SSH-Sitzung werden deren laufende und wartende Aufträge abgebrochen; spät zurückkehrende Dateidialoge dürfen keine neuen Aufträge für diese Sitzung einreihen. Überschreibkonflikte werden vor dem jeweiligen Upload behandelt.

`ssh/actions.rs` überträgt Dateien in 64-KiB-Blöcken, meldet Fortschritt über einen Channel und beobachtet Abbruchsignale. Upload und Download betreffen Dateien; Ordnertransfer ist nicht implementiert. Rekursive Lösch- und Berechtigungsaktionen verwenden Symlink-Metadaten und folgen Symlinks nicht absichtlich in Unterverzeichnisse. Der Ordnervergleich ist ein eigener, abbrechbarer Vorgang und keine Transferfunktion.

## Editor: Dokumente, Schreiben und Cache

Das Backend liest Rohbytes und akzeptiert UTF-8 mit oder ohne BOM bis 10 MiB; Binärdaten und ungültiges UTF-8 werden abgelehnt. Es zählt CRLF, LF und CR, meldet gemischte Zeilenenden und normalisiert intern auf LF. Beim Speichern wird das gewählte Zeilenende rekonstruiert und die BOM-Einstellung berücksichtigt. Gemischte Zeilenenden erfordern eine ausdrückliche Auswahl.

CodeMirror bietet Syntaxfarben, Faltung und Suchen/Ersetzen. Farbdekorationen berücksichtigen den sichtbaren Bereich. `src/lib/colorCodes.ts` berechnet `L = 0.299R + 0.587G + 0.114B`; oberhalb von 140 wird schwarzer, sonst weißer Text verwendet. Alpha wird vor der Kontrastwahl mit dem Hintergrund verrechnet.

Ein Backend-Dokument hält Quelle, ursprüngliche Bytes und Metadaten. Remote-Konfliktschutz vergleicht Größe und sekundengenaue Änderungszeit. Gleich große Änderungen innerhalb derselben Sekunde bleiben unter Umständen unentdeckt; ein erneuter Inhaltsvergleich ist hier nicht implementiert. Lokal werden zusätzlich die genauere Änderungszeit und Dateiidentität geprüft. Die Prüfung erfolgt am geöffneten Handle. Die Oberfläche bietet bei Konflikten Neuladen beziehungsweise bewusstes Überschreiben an und fragt bei ungespeicherten Änderungen vor dem Schließen.

Gespeichert wird in-place, nicht durch Austausch gegen eine neue Datei. Remote wird ohne anfängliches Trunkieren geöffnet, nach der Konfliktprüfung geschrieben, die Endgröße gesetzt und die zuvor am Handle gelesenen Rechte wieder gesetzt; anschließend wird synchronisiert und geschlossen. Lokal wird ebenfalls am geöffneten Handle geschrieben und die Länge angepasst. Ein Fehler kann eine teilweise geschriebene Datei hinterlassen: `WRITE_FAILED` weist auf die Sicherung hin; der bearbeitete Inhalt bleibt im Editor.

Vor dem Schreiben wird der bekannte Ausgangsinhalt im lokalen App-Cache gesichert. Jede App-Instanz besitzt einen eigenen Unterordner und hält dessen `instance.lock` gesperrt. Die Bereinigung prüft diese Sperre und lässt aktive Instanzen sowie unbekannte Einträge in Ruhe. Dokument-Schließen entfernt zugehörige Cachedateien; fehlgeschlagene Löschungen werden erneut versucht. Beim regulären App-Ende wird der Instanzcache entfernt. Diese Dateien sind temporäre Sicherungen, kein dauerhaftes Backup oder zugesichertes Wiederherstellungssystem.

## Sitzungen, Schlüsselbund und Migration

`sessions.json` im Tauri-App-Konfigurationsverzeichnis enthält Sitzungsparameter ohne gespeicherte Passwörter. Separate Dateien halten zuletzt verwendete Sitzungen, letzte Tabs und Tunneldefinitionen. Makros enthalten dagegen bewusst Klartext-Schritte; aufgezeichnete Geheimnisse wären dadurch ebenfalls gespeichert.

`secrets.rs` nutzt `keyring` für den System-Schlüsselbund: unter Linux Secret Service, unter Windows den nativen Store. Fehlender D-Bus/Secret Service, gesperrte Sammlung und andere Fehler werden kategorisiert, ohne beliebige Providertexte als Diagnosen weiterzugeben. Ohne verfügbaren Store funktionieren gespeicherte Passwortoperationen nicht zuverlässig; insbesondere WSL stellt ihn nicht automatisch bereit.

Importmodule lesen MobaXterm-/WindTerm-Sitzungsdaten; WindTerm-OneKey-Zuordnungen betreffen öffentliche Metadaten, keine Entschlüsselung gespeicherter Geheimnisse. Der Farbimport ist in `terminal_colors.rs` getrennt implementiert.

## sudo-Modus

`ssh/sudo.rs` schaltet für den Browser auf einen erhöht gestarteten SFTP-Server um. Ohne Passwort wird zunächst `sudo -n true` geprüft. Der Serverpfad wird ausschließlich aus festen Kandidaten gewählt. Mit Passwort nutzt der Start `sudo -k -S -p ''`: Das erzwungene Lesen verhindert, dass bei bereits gecachten sudo-Rechten die Passwortzeile an den SFTP-Server gelangt.

Das Passwort geht nur an sudo, wird nicht persistiert und liegt in einem nicht diagnostizierbaren, beim Freigeben überschriebenen Puffer. Umschaltvorgänge sind serialisiert. Beim Abschalten werden neue Aktionen sofort nicht mehr auf den erhöhten Kanal geleitet; bestehende Kanalreferenzen laufender Aktionen werden berücksichtigt. Remote-Editor-Dokumente halten fest, ob sie im sudo-Modus geöffnet wurden, und speichern bei inzwischen deaktiviertem Modus nicht still über einen anderen Kanal.

## Linux-PTY-Beendigung

`pty.rs` liest unter Unix mit `poll` und einem Stoppsignal, statt unbegrenzt auf einen offen gehaltenen PTY-Slave zu warten. Beim Beenden wird die geprüfte Shell-Prozessgruppe zunächst mit SIGHUP signalisiert. Nach zwei Sekunden erfolgt bei Bedarf SIGKILL. Signale werden vor dem Freigeben der Kindprozess-ID gesendet, damit keine wiederverwendete ID getroffen wird. Tests prüfen unter anderem Hintergrundprozesse und eine SIGHUP ignorierende Shell. Die entsprechenden älteren Fehlereinträge in STATUS.md sind durch diese Implementierung überholt.

## Tests und Prüfgrenzen

Rust-Tests stehen in den Backend-Modulen, darunter SSH-Pump/Aufbauabbruch, Import/Migration, Tunnel, Dateizugriffe, EOL/BOM-Fixtures, Konflikte, Cache und Unix-PTY. Frontend-Tests (`*.test.ts`/`*.test.tsx`) prüfen unter anderem OSC 7, Prompt-Hooks, Farbkontrast, Editorlogik, Warteschlange, MultiExec, Makros und Vergleiche. `tests/fixtures/eol/` enthält bytegenaue Testdateien; ihre Zeilenenden dürfen nicht automatisch konvertiert werden.

Vom Projektverzeichnis aus, Shell Bash:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

Beide Befehle sollen erfolgreich enden. Linux-spezifische Tests benötigen Linux oder WSL. Ein ignorierter Live-SSH-Test benötigt ein ausdrücklich eingerichtetes Testziel und Zugangsdaten aus Umgebungsvariablen; normale Unit-Tests ersetzen diesen Integrationstest nicht. Ein manueller Telnet-Testserver liegt unter `tests/manual/`.

Diese Dokumentation wurde anhand von Code, Manifesten und STATUS.md erstellt; sie protokolliert keinen neuen Build- oder Testlauf. Paketnamen und frühere manuelle Testergebnisse stammen aus STATUS.md. Noch offen sind dort insbesondere der Linux-Pakettest der Seriell-Berechtigungshilfe mit echtem Gerät und die Fenster-Schließen-Rückfrage. Release-Verfügbarkeit, externe Markenrechte und die tatsächliche Nutzung der in der Herkunft genannten KI-Werkzeuge lassen sich aus dem Anwendungscode nicht beweisen.
