# Quodliber

Echtzeit-Ko-Schreiben an einer Textdatei — **serverlos**, eine Installation pro
Person, Ende-zu-Ende-verschlüsselt übers Internet. Der Name: „Quodlibet"
(lat. „was beliebt"; musikalische Form verwobener Stimmen) × „liber" (Buch).

Zwei (perspektivisch mehr) Personen tippen gleichzeitig im selben Dokument —
zeichen-granular, mit Cursor-Anzeige, Autorenfärbung und verlustfreiem Merge
nach Verbindungsabbrüchen (Yjs-CRDT).

## Verbinden

- **LAN:** Host klickt „Session starten" — Gäste sehen die Session automatisch
  als Chip in der Toolbar (mDNS) und treten per Klick bei. Der Host bestätigt
  jeden neuen Gast; bestätigte Personen werden wiedererkannt (TOFU).
- **Internet:** Host klickt „Internet-Session" → Code per Messenger an den
  Gast → Gast drückt im Quodliber-Fenster Strg+V → Antwort-Code zurück →
  Host drückt Strg+V. Verschlüsselt via WebRTC/DTLS; nur zustandslose
  STUN-Server als Fremd-Infrastruktur, kein Konto, kein Relay, kein Server.

Grenzen und Planung: siehe [ROADMAP.md](ROADMAP.md).

## Entwicklung

```powershell
npm install
npm run tauri dev        # Dev-Fenster (braucht laufendes vite)
npm run tauri build      # Release + Installer (NSIS/MSI)
node tools\test-author-runs.mjs   # Erdungstests der Autoren-Attribution
node tools\robo-peer.mjs [ip:port] # Protokoll-Zweitclient für Gleichzeitigkeits-Tests
```

Stack: Tauri v2 (Rust) · CodeMirror 6 + Yjs (TypeScript) · webrtc-rs · mdns-sd.
Lizenzkette vollständig MIT/Apache-kompatibel.
