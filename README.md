# Quodliber

Real-time collaborative writing on plain text files — **serverless**, one
installation per person, end-to-end encrypted over the internet. The name
blends "quodlibet" (Latin *"what pleases"*; a musical form of interwoven
voices) with "liber" (Latin *book*).

Two people (more planned) type simultaneously in the same document —
character-granular, with live cursors, per-author coloring, and lossless
merging after connection drops (Yjs CRDT).

> [!WARNING]
> **Experimental — not for important data yet.** Early-stage (v0.1),
> unsigned binaries, limited real-world testing. Internet sessions are
> DTLS-encrypted; the LAN/TCP path is currently **unencrypted** (see
> [ROADMAP.md](ROADMAP.md)). Keep backups of anything you edit with it.

## Connecting

- **LAN:** The host clicks "Session starten" — guests see the session appear
  automatically as a chip in the toolbar (mDNS) and join with one click. The
  host confirms every new guest; confirmed peers are recognized on future
  joins (trust on first use).
- **Internet:** The host clicks "Internet-Session" → sends the generated code
  via any messenger → the guest presses Ctrl+V inside the Quodliber window →
  sends the answer code back → the host presses Ctrl+V. Encrypted via
  WebRTC/DTLS; the only third-party infrastructure is stateless STUN — no
  accounts, no relays, no servers.

Limitations and plans: see [ROADMAP.md](ROADMAP.md).

## Development

```powershell
npm install
npm run tauri dev        # dev window (requires running vite)
npm run tauri build      # release + installers (NSIS/MSI)
node tools\test-author-runs.mjs    # grounding tests for author attribution
node tools\robo-peer.mjs [ip:port] # independent protocol client for concurrency tests
```

Stack: Tauri v2 (Rust) · CodeMirror 6 + Yjs (TypeScript) · webrtc-rs · mdns-sd.
The entire license chain is MIT/Apache-compatible.

## Security & supply chain

Verifiable with two commands (as of 2026-07-23: both clean):

```powershell
npm audit                      # CVE check, frontend (49 packages total)
cargo audit                    # RustSec check, backend (510 crates total)
```

- **Lockfiles committed** (`package-lock.json`, `Cargo.lock`) — installs are
  bit-for-bit reproducible; npm/crates.io versions are immutable.
- **No framework, no CDN resources:** the frontend is 49 npm packages, fully
  bundled; a strict CSP ships in release builds (no external sources).
- **Network behavior:** internet sessions are DTLS end-to-end encrypted; the
  only third-party infrastructure is stateless STUN (never sees content).
  The LAN/TCP path is currently unencrypted (see ROADMAP → E2E everywhere).
- **Honest residual risks:** the Yjs and CodeMirror ecosystems are
  single-maintainer projects (hugely adopted, but a single-maintainer supply
  chain); the Rust tree is large (webrtc/tauri); cargo-audit reports two
  "unmaintained" notices in transitive crates (unic-ucd-*) and one
  unsoundness note (`glib`, Linux-only — not part of the Windows binary).
- Planned hardening (ROADMAP): `cargo deny` in CI, `cargo vet`
  (shared audit database), npm provenance, code signing.
