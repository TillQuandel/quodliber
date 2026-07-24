// Robo-Peer: verbindet sich als Gast mit einer Quodliber-Session und tippt
// automatisch — für den Gleichzeitigkeits-Realtest (ein Mensch, zwei Fenster
// geht nicht). Spricht dasselbe Protokoll wie die App: u32-BE-Längenprefix,
// [Typ-VarUint][Payload] mit y-protocols Sync + Awareness.
// Aufruf: node tools/robo-peer.mjs [ip:port]
import net from "node:net";
import fs from "node:fs";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_HELLO = 3;
const MSG_WELCOME = 4;
const MSG_REJECT = 5;
const ROBO_ID = "robo-peer-1";
const TARGET = process.argv[2] ?? "127.0.0.1:41420";
const TYPE_MS = 150;
const TYPE_SECONDS = 60;
const SETTLE_SECONDS = 8;
const RETRY_MS = 2000;
const MAX_WAIT_MS = 600000;

const [ip, portStr] = TARGET.split(":");
const doc = new Y.Doc();
const ytext = doc.getText("content");
const awareness = new awarenessProtocol.Awareness(doc);
awareness.setLocalStateField("user", {
  name: "Robo",
  color: "#8e44ad",
  light: "#8e44ad33",
});

const SENTENCE =
  " [Robo] tippt parallel diesen Satz, Zeichen fuer Zeichen, ans Dokument-Ende — aeoeu-Umlaute inklusive. ";

let sock = null;
let synced = false;
let typing = false;
let done = false;
const startedAt = Date.now();

function sendFrame(u8) {
  if (!sock || sock.destroyed) return;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(u8.length);
  sock.write(Buffer.concat([len, Buffer.from(u8)]));
}

doc.on("update", (update, origin) => {
  if (origin === "remote") return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  sendFrame(encoding.toUint8Array(enc));
});

function startTyping() {
  if (typing || done) return;
  typing = true;
  console.log(`[robo] synced (${ytext.length} Zeichen) — tippe ${TYPE_SECONDS}s lang …`);
  let i = 0;
  const typer = setInterval(() => {
    ytext.insert(ytext.length, SENTENCE[i % SENTENCE.length]);
    i++;
  }, TYPE_MS);
  setTimeout(() => {
    clearInterval(typer);
    console.log("[robo] Tippen beendet, warte auf Settle …");
    setTimeout(() => {
      done = true;
      const out = new URL("./robo-final.txt", import.meta.url);
      fs.writeFileSync(out, ytext.toString(), "utf8");
      console.log(`[robo] final: ${ytext.length} Zeichen -> tools/robo-final.txt`);
      sock?.end();
      process.exit(0);
    }, SETTLE_SECONDS * 1000);
  }, TYPE_SECONDS * 1000);
}

function connect() {
  if (done) return;
  if (Date.now() - startedAt > MAX_WAIT_MS) {
    console.error("[robo] Aufgegeben — kein freier Session-Slot (Gast-Fenster auf 'Verlassen'?)");
    process.exit(1);
  }
  let recvBuf = Buffer.alloc(0);
  synced = false;
  sock = net.createConnection(Number(portStr), ip);
  sock.setNoDelay(true);

  sock.on("connect", () => {
    // Beitritts-Handshake: erst vorstellen, Sync startet nach WELCOME
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_HELLO);
    encoding.writeVarString(enc, JSON.stringify({ id: ROBO_ID, name: "Robo" }));
    sendFrame(encoding.toUint8Array(enc));
    console.log("[robo] HELLO gesendet — warte auf Host-Bestätigung …");
  });

  sock.on("data", (chunk) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    while (recvBuf.length >= 4) {
      const len = recvBuf.readUInt32BE(0);
      if (recvBuf.length < 4 + len) break;
      const payload = recvBuf.subarray(4, 4 + len);
      recvBuf = recvBuf.subarray(4 + len);
      const dec = decoding.createDecoder(new Uint8Array(payload));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, doc, "remote");
        if (encoding.length(enc) > 1) sendFrame(encoding.toUint8Array(enc));
        if (!synced) {
          synced = true;
          // kurz warten bis SyncStep2 verarbeitet ist, dann lostippen
          setTimeout(startTyping, 1500);
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(dec),
          "remote",
        );
      } else if (type === MSG_WELCOME) {
        console.log("[robo] WELCOME — starte Sync");
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc, doc);
        sendFrame(encoding.toUint8Array(enc));
        const enc2 = encoding.createEncoder();
        encoding.writeVarUint(enc2, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          enc2,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
        );
        sendFrame(encoding.toUint8Array(enc2));
      } else if (type === MSG_REJECT) {
        console.error("[robo] Host hat abgelehnt — Ende");
        process.exit(1);
      } else if (type === 6 && decoding.hasContent(dec)) {
        // PING mit Sequenz → PONG für die RTT-Anzeige der Gegenseite
        const seq = decoding.readVarUint(dec);
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 7);
        encoding.writeVarUint(enc, seq);
        sendFrame(encoding.toUint8Array(enc));
      }
      // MSG_META (2) ignorieren — Robo joint immer frisch
    }
  });

  const retry = () => {
    if (done || typing) {
      if (typing && !done) {
        console.error("[robo] Verbindung während des Tippens verloren — Abbruch");
        process.exit(1);
      }
      return;
    }
    setTimeout(connect, RETRY_MS);
  };
  sock.on("close", retry);
  sock.on("error", () => {});
}

console.log(`[robo] verbinde mit ${TARGET} (Retry alle ${RETRY_MS / 1000}s, max ${MAX_WAIT_MS / 1000}s) …`);
connect();
