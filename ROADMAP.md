# Quodliber — Roadmap

Quodliber ist ein eigenständiges Tool für Echtzeit-Ko-Schreiben an Textdateien —
serverlos (kein von irgendwem für uns betriebener Dienst), eine Installation pro
Person, FOSS. Ein Obsidian-Plugin ist später als Zusatz geplant, kein Ersatz.
Entscheidungs-Historie: Projekt-Note „Echtzeit-Ko-Schreiben" im Vault.

## Erledigt (real getestet)

- Editor (CodeMirror 6) + Markdown-Datei öffnen/speichern, Auto-Sichern (~2 s),
  Crash-Kopie mit Wiederherstellen-Banner
- Echtzeit-Sync für 2 Peers (Yjs; zeichen-granular, verlustfreier
  Reconnect-Merge, Doc-GUID-Wechselerkennung) — Gleichzeitigkeit byte-verifiziert
- Autorenfärbung mit Session-Baseline (Datei-Bestand neutral), Namensfeld,
  Autoren-Fokus per Legende-Klick, Farben-Schalter
- Transport A: TCP im LAN (`ip:port`) · Transport B: Internet via WebRTC
  (QL1-Code-Tausch, Vanilla-ICE, STUN, DTLS-E2E), Strg+V-Einfüge-Automatik
- LAN-Discovery (mDNS) mit Null-Code-Beitritt, Beitritts-Bestätigung
  (HELLO/WELCOME/REJECT vor jedem Sync) + TOFU-Wiedererkennung
- **Remote-NAT-Realtest bestanden** (2026-07-24, zwei echte Heimnetze,
  serverlos, nur STUN) — das Kernversprechen ist empirisch belegt
- Härtung nach Review (2026-07-24, alles real nachgestellt): Beitritts-
  Bestätigung wird auch beim **Empfang** durchgesetzt (vorher konnte jeder,
  der den Kanal erreichte, ins geteilte Dokument schreiben), Vertrauensliste
  pro Datei statt installationsweit + einsehbar, Autosave geht bei Tab- und
  Fensterschluss nicht mehr verloren und leert keine bestehende Datei
  automatisch, WebRTC-Sessions können sich nicht mehr gegenseitig kapern,
  Port-Ausweichen wenn 41420 belegt ist

## Jetzt

1. **Kompakt-Codes** — eigenes Ticket-Format statt base64-SDP (Remote-Test-
   Fund: der Code ist zu lang zum Verschicken)
2. **M4 — Mehr-Peer-Sessions + Teilnehmer-Panel** (siehe unten)

Offene Punkte mit ausgearbeiteter Abwägung liegen als Issues im Repo:
Dokumentwechsel-Datenverlust (#1), Transport-Härtung vor der Bestätigung (#2),
Dateizugriff eingrenzen (#3), Krypto-Identität (#4).

## Als Nächstes

- **M4 — Mehr-Peer-Sessions + Gruppenfeld:** Stern-Topologie über den Host
  (Peer-Kennung in der Byte-Brücke, Broadcast vs. gezielte Sync-Antworten),
  Beitritts-Bestätigung pro Gast, Teilnehmer-Panel aus der Awareness
- **Ansicht folgen** (optional): Gast folgt dem aktiven Tab des Hosts —
  heute bewusst entkoppelt (geteilt wird ein Dokument, nicht die Ansicht)
- **Kick-Politur:** eigene „Du wurdest getrennt"-Meldung (heute identisch
  mit Beitritts-Ablehnung)
- **E2E überall:** TCP/LAN-Pfad (heute Klartext) durch WebRTC mit
  mDNS-als-LAN-Signaling ersetzen → ein Transportpfad, alles DTLS
- **Verbindungs-Komfort:** Kompakt-Codes (eigenes Ticket-Format statt
  SDP-Base64), `quodliber://`-Klick-Links, Ein-Weg-Code + Host-Bestätigung
  bei erreichbarem Host (UPnP/IPv6)
- **Berechtigungs-Optionen:** Host konfiguriert Gast-Rechte (z. B.
  Nur-Lesen-Gäste, Gast darf Datei vorschlagen); Anzeige existiert bereits
  (Rollen-Info in der Statusleiste). Hinweis: Nur-Lesen ist zunächst
  UI-Durchsetzung (kooperatives Szenario), harte Durchsetzung bräuchte
  Op-Filterung auf Host-Seite

## Später

- **Verlauf:** persistenter Update-Log mit Zeitstempeln neben der Datei
  (Sidecar) → „wer hat wann was geschrieben", Timeline-Ansicht,
  Attribution überlebt Datei-Neuöffnung
- Mehr-Datei-Sessions (ganze Ordner teilen)
- Markdown-Preview
- Krypto-Identität (Schlüsselpaare statt Zufalls-ID; heute spoofbar) — #4
- Code-Signing des Installers (SmartScreen), Auto-Updater
- Obsidian-Plugin als Quodliber-Anschluss

## Bekannte Grenzen (dokumentiert)

- LAN/TCP-Transport unverschlüsselt (Internet-Pfad ist DTLS-E2E)
- Session = genau 1 Peer, genau 1 Datei; Zusatzverbindungen werden still
  abgewiesen
- Vertrauen gilt pro Datei und wird nur behauptet, nicht bewiesen — die
  Peer-ID ist eine Zufalls-ID ohne Kryptografie (#4)
- Autoren-Attribution lebt pro Doc-Inkarnation (bis „Verlauf" kommt)
- Internet ohne Relay: NAT-Erfolgsquote ~70–85 %-Klasse, beidseitig
  symmetrische NATs scheitern (Hotspot-Trick als Ausweich)
- Serverlos-Preis: 2×-Code-Tausch übers Internet ist ohne Relay nicht
  weiter reduzierbar
