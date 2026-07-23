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

## Jetzt

1. **Robustheit:** Heartbeat (Traffic-Überwachung) + Auto-Reconnect
   (Gast: automatische Wiederverbindung mit Backoff; Host: automatisches
   Re-Listen), sichtbarer Verbindungszustand
2. **Tabs:** mehrere Dateien gleichzeitig offen; Session teilt weiterhin genau
   eine Datei (Mehr-Datei-Sessions siehe „Später")
3. **Mehr Dateitypen:** alle Textformate öffnen (txt/md/csv/json/…, Erkennung
   binär vs. Text statt Endungs-Whitelist)

## Als Nächstes

- **M4 — Mehr-Peer-Sessions + Gruppenfeld:** Stern-Topologie über den Host
  (Peer-Kennung in der Byte-Brücke, Broadcast vs. gezielte Sync-Antworten),
  Beitritts-Bestätigung pro Gast, Teilnehmer-Panel aus der Awareness
- **Remote-NAT-Realtest** (zwei echte Heimnetze) → entscheidet über
  UPnP-Booster und die weitere Transport-Härtung
- **E2E überall:** TCP/LAN-Pfad (heute Klartext) durch WebRTC mit
  mDNS-als-LAN-Signaling ersetzen → ein Transportpfad, alles DTLS
- **Verbindungs-Komfort:** Kompakt-Codes (eigenes Ticket-Format statt
  SDP-Base64), `quodliber://`-Klick-Links, Ein-Weg-Code + Host-Bestätigung
  bei erreichbarem Host (UPnP/IPv6)

## Später

- **Verlauf:** persistenter Update-Log mit Zeitstempeln neben der Datei
  (Sidecar) → „wer hat wann was geschrieben", Timeline-Ansicht,
  Attribution überlebt Datei-Neuöffnung
- Mehr-Datei-Sessions (ganze Ordner teilen)
- Markdown-Preview
- Krypto-Identität (Schlüsselpaare statt Zufalls-ID; heute spoofbar)
- Code-Signing des Installers (SmartScreen), Auto-Updater
- Obsidian-Plugin als Quodliber-Anschluss

## Bekannte Grenzen (dokumentiert)

- LAN/TCP-Transport unverschlüsselt (Internet-Pfad ist DTLS-E2E)
- Session = genau 1 Peer, genau 1 Datei; Zusatzverbindungen werden still
  abgewiesen
- Autoren-Attribution lebt pro Doc-Inkarnation (bis „Verlauf" kommt)
- Internet ohne Relay: NAT-Erfolgsquote ~70–85 %-Klasse, beidseitig
  symmetrische NATs scheitern (Hotspot-Trick als Ausweich)
- Serverlos-Preis: 2×-Code-Tausch übers Internet ist ohne Relay nicht
  weiter reduzierbar
