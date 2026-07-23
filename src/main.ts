import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import {
  authorColoring,
  authorRuns,
  authorsRefresh,
  captureBaseline,
  clearBaseline,
  coloringActive,
  focusedAuthorId,
  NEUTRAL,
  paletteFor,
  toggleColoring,
  toggleFocus,
} from "./author-colors";

// Nachrichten-Envelope wie bei y-websocket: [Typ-VarUint][Payload]
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Doc-GUID-Ansage: erkennt beim Re-Join, ob der Host inzwischen ein anderes
// Dokument teilt (dann muss der Gast neu adoptieren statt zu mergen)
const MSG_META = 2;
// Beitritts-Handshake: Gast stellt sich vor (HELLO), Host bestätigt (WELCOME)
// oder lehnt ab (REJECT). Vor WELCOME fließt kein Dokument-Inhalt (TOFU-Muster).
const MSG_HELLO = 3;
const MSG_WELCOME = 4;
const MSG_REJECT = 5;
const SESSION_PORT = 41420;

// Persistente Install-Identität (v0: zufällige ID, keine Kryptografie —
// spoofbar, fürs LAN-/Bekannten-Szenario akzeptiert; echte Schlüssel später)
const IDENTITY_KEY = "quodliber-id";
const KNOWN_KEY = "quodliber-known-peers";
const myId = (() => {
  let v = localStorage.getItem(IDENTITY_KEY);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(IDENTITY_KEY, v);
  }
  return v;
})();

function knownPeers(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function rememberPeer(id: string, name: string) {
  const k = knownPeers();
  k[id] = name;
  localStorage.setItem(KNOWN_KEY, JSON.stringify(k));
}

// --- Yjs-Kern: Der Y.Doc ist die Source of Truth, der Editor hängt via yCollab dran.
// Pro geöffneter Datei ein frischer Doc. Beim Session-Beitritt adoptiert der Gast den
// Host-State (eigener Doc wird leer zurückgesetzt) — nie zwei unabhängige Historien.
let ydoc = new Y.Doc();
let ytext = ydoc.getText("content");
let awareness = new Awareness(ydoc);
let undoManager = new Y.UndoManager(ytext);

let currentPath: string | null = null;
let view: EditorView | null = null;

type Mode = "idle" | "hosting" | "joined";
let mode: Mode = "idle";
let connected = false;
// Beitritt vom Host bestätigt? Vorher fließen keine Sync-/Awareness-Bytes.
let authorized = false;
let pendingHello: { id: string; name: string } | null = null;
let wiredFor: Y.Doc | null = null;
// Gast-Seite: GUID des Host-Docs aus der laufenden Session (null = keine Session)
let hostGuid: string | null = null;
let lastJoinedAddr: string | null = null;
// Gast-Seite: Baseline wird nach dem ersten SyncStep2 der Session gesetzt
let guestBaselinePending = false;
// Internet-Session (Host): Offer verschickt, Antwort-Code ausstehend
let inetAwaitingAnswer = false;
const CODE_PREFIX = "QL1-";

const el = {
  open: document.querySelector<HTMLButtonElement>("#btn-open")!,
  save: document.querySelector<HTMLButtonElement>("#btn-save")!,
  host: document.querySelector<HTMLButtonElement>("#btn-host")!,
  inet: document.querySelector<HTMLButtonElement>("#btn-inet")!,
  join: document.querySelector<HTMLButtonElement>("#btn-join")!,
  joinInput: document.querySelector<HTMLInputElement>("#join-input")!,
  nameInput: document.querySelector<HTMLInputElement>("#name-input")!,
  sessionCode: document.querySelector<HTMLSpanElement>("#session-code")!,
  fileLabel: document.querySelector<HTMLDivElement>("#file-label")!,
  editor: document.querySelector<HTMLElement>("#editor")!,
  statusConn: document.querySelector<HTMLSpanElement>("#status-conn")!,
  statusMsg: document.querySelector<HTMLSpanElement>("#status-msg")!,
  legend: document.querySelector<HTMLSpanElement>("#author-legend")!,
  colorsToggle: document.querySelector<HTMLButtonElement>("#btn-colors")!,
  recoveryBanner: document.querySelector<HTMLDivElement>("#recovery-banner")!,
  recover: document.querySelector<HTMLButtonElement>("#btn-recover")!,
  recoverDismiss: document.querySelector<HTMLButtonElement>("#btn-recover-dismiss")!,
  joinBanner: document.querySelector<HTMLDivElement>("#join-banner")!,
  jrText: document.querySelector<HTMLSpanElement>("#jr-text")!,
  jrAccept: document.querySelector<HTMLButtonElement>("#btn-jr-accept")!,
  jrReject: document.querySelector<HTMLButtonElement>("#btn-jr-reject")!,
  lanList: document.querySelector<HTMLSpanElement>("#lan-list")!,
};

// LAN-Hosts aus der mDNS-Discovery (fullname → Eintrag)
const lanHosts = new Map<string, { label: string; addr: string; id: string }>();

function renderLanList() {
  el.lanList.innerHTML = "";
  if (mode !== "idle") return;
  for (const [fullname, h] of lanHosts) {
    if (h.id === myId) continue; // eigene Ansage nicht anbieten
    const chip = document.createElement("button");
    chip.className = "lan-chip";
    chip.textContent = `⌂ ${h.label}`;
    chip.title = `LAN-Session beitreten (${h.addr})`;
    chip.addEventListener("click", () => {
      el.joinInput.value = h.addr;
      void joinSession();
    });
    el.lanList.appendChild(chip);
    void fullname;
  }
}

// Autoren-Register für die Legende: clientID → Name. Lebt pro Doc-Inkarnation;
// Namen kommen aus der Awareness (verbundene Peers) bzw. dem eigenen Namensfeld.
const authorNames = new Map<number, string>();

const NAME_STORAGE_KEY = "quodliber-name";

function authorName(clientId: number): string {
  return authorNames.get(clientId) ?? `Autor-${clientId % 1000}`;
}

function localUser() {
  const custom = el.nameInput.value.trim();
  const name = custom || `Autor-${ydoc.clientID % 1000}`;
  const pal = paletteFor(ydoc.clientID);
  authorNames.set(ydoc.clientID, name);
  return { name, color: pal.color, colorLight: pal.light };
}

function refreshAuthorUi() {
  view?.dispatch({ effects: authorsRefresh.of(null) });
  updateLegend();
}

function updateLegend() {
  el.legend.innerHTML = "";
  const runs = authorRuns(ytext);
  if (!coloringActive(runs)) return;
  const clients = new Set(
    runs.filter((r) => r.client !== NEUTRAL).map((r) => r.client),
  );
  for (const id of clients) {
    const chip = document.createElement("span");
    chip.className = "author-chip";
    if (focusedAuthorId() === id) chip.classList.add("focused");
    chip.style.backgroundColor = paletteFor(id).light;
    chip.style.borderColor = paletteFor(id).color;
    chip.textContent = authorName(id);
    chip.title = "Klick: diesen Autor hervorheben";
    chip.addEventListener("click", () => {
      toggleFocus(id);
      refreshAuthorUi();
    });
    el.legend.appendChild(chip);
  }
}

function harvestAwarenessNames() {
  for (const [id, state] of awareness.getStates()) {
    const name = (state as { user?: { name?: string } }).user?.name;
    if (name) authorNames.set(id, name);
  }
}

// Beobachter pro Doc-Inkarnation: Legende bei Text- und Namensänderungen nachziehen
function registerDocObservers() {
  ydoc.on("update", () => {
    updateLegend();
    scheduleAutosave();
  });
  awareness.on("change", () => {
    harvestAwarenessNames();
    updateLegend();
  });
}

// --- Auto-Sichern: Host/Solo mit Pfad → in die Datei; Gast ohne Pfad → Crash-Kopie
// im App-Datenordner (wird beim nächsten Start gemeldet).

let recoveryPath: string | null = null;
let autosaveTimer: number | undefined;

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void autosave(), 2000);
}

async function autosave() {
  const text = ytext.toString();
  try {
    if (currentPath) {
      await invoke("write_file", { path: currentPath, contents: text });
      if (!el.statusMsg.textContent || el.statusMsg.textContent.startsWith("Auto")) {
        status(`Auto-gespeichert ${new Date().toLocaleTimeString()}`);
      }
    } else if (recoveryPath && text.length > 0) {
      await invoke("write_file", { path: recoveryPath, contents: text });
    }
  } catch {
    // Autosave scheitert still — expliziter Strg+S-Pfad meldet Fehler sichtbar
  }
}

function status(msg: string, isError = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("error", isError);
}

function connStatus(text: string) {
  el.statusConn.textContent = text;
}

function updateSessionUi() {
  const rejoinable = mode === "joined" && !connected;
  const answerPaste = mode === "hosting" && inetAwaitingAnswer;
  el.host.textContent =
    mode === "hosting" ? "Session beenden" : mode === "joined" ? "Verlassen" : "Session starten";
  el.join.textContent = answerPaste
    ? "Verbinden"
    : rejoinable
      ? "Erneut verbinden"
      : mode === "joined"
        ? "Verbunden"
        : "Beitreten";
  // Host-Button ist in jedem Modus die aktive Aktion (Starten/Beenden/Verlassen)
  el.host.disabled = false;
  el.inet.disabled = mode !== "idle";
  el.join.disabled = (mode === "hosting" && !answerPaste) || (mode === "joined" && connected);
  el.joinInput.disabled = !(mode === "idle" || answerPaste);
  el.joinInput.placeholder = answerPaste ? "Antwort-Code (QL1-…) einfügen" : "ip:port oder QL1-Code";
  el.open.disabled = mode !== "idle";
  if (mode === "idle") el.sessionCode.textContent = "";
  updateSaveButton();
  renderLanList();
}

// Code in die Zwischenablage; Fallback: ins Join-Feld legen zum manuellen Kopieren
function copyCode(code: string, label: string) {
  void navigator.clipboard.writeText(code).then(
    () => status(`${label} kopiert — per Messenger an die Gegenseite senden`),
    () => {
      el.joinInput.value = code;
      status(`${label} liegt im Eingabefeld — manuell kopieren (Strg+A, Strg+C)`, true);
    },
  );
}

// --- Transport-Brücke: Bytes rein/raus über Tauri; der Kanal dahinter ist austauschbar
// (M2: TCP, M3: WebRTC-DataChannel). Das Protokoll-Framing hier bleibt identisch.

// Roh-Senden für den Beitritts-Handshake (läuft VOR der Autorisierung)
function rawSend(payload: Uint8Array) {
  if (!connected) return;
  void invoke("net_send", { data: Array.from(payload) }).catch(() => {});
}

function sendBytes(payload: Uint8Array) {
  if (!connected || !authorized) return;
  void invoke("net_send", { data: Array.from(payload) }).catch(() => {});
}

function sendControl(type: number, data: { id: string; name: string } | null) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  encoding.writeVarString(enc, data ? JSON.stringify(data) : "{}");
  rawSend(encoding.toUint8Array(enc));
}

function currentName(): string {
  return el.nameInput.value.trim() || `Autor-${ydoc.clientID % 1000}`;
}

function sendHandshake() {
  if (mode === "hosting") {
    const encMeta = encoding.createEncoder();
    encoding.writeVarUint(encMeta, MSG_META);
    encoding.writeVarString(encMeta, ydoc.guid);
    sendBytes(encoding.toUint8Array(encMeta));
  }

  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, ydoc);
  sendBytes(encoding.toUint8Array(enc));

  const enc2 = encoding.createEncoder();
  encoding.writeVarUint(enc2, MSG_AWARENESS);
  encoding.writeVarUint8Array(
    enc2,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
  );
  sendBytes(encoding.toUint8Array(enc2));
}

function wireDoc() {
  if (wiredFor === ydoc) return;
  wiredFor = ydoc;
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || !connected) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    sendBytes(encoding.toUint8Array(enc));
  });
  awareness.on(
    "update",
    (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === "remote" || !connected) return;
      const changed = changes.added.concat(changes.updated, changes.removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      sendBytes(encoding.toUint8Array(enc));
    },
  );
}

function handleIncoming(data: Uint8Array) {
  const dec = decoding.createDecoder(data);
  const type = decoding.readVarUint(dec);
  if (type === MSG_SYNC) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const msgType = syncProtocol.readSyncMessage(dec, enc, ydoc, "remote");
    if (encoding.length(enc) > 1) sendBytes(encoding.toUint8Array(enc));
    // Gast-Baseline: nach dem ersten vollständigen Host-Stand (SyncStep2) —
    // ab hier zählt Getipptes als Session-Beitrag, alles davor als Bestand
    if (
      guestBaselinePending &&
      msgType === syncProtocol.messageYjsSyncStep2
    ) {
      guestBaselinePending = false;
      captureBaseline(ydoc);
      refreshAuthorUi();
    }
  } else if (type === MSG_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      awareness,
      decoding.readVarUint8Array(dec),
      "remote",
    );
  } else if (type === MSG_HELLO) {
    if (mode !== "hosting") return;
    let hello: { id?: string; name?: string };
    try {
      hello = JSON.parse(decoding.readVarString(dec)) as { id?: string; name?: string };
    } catch {
      return;
    }
    const peer = { id: hello.id ?? "", name: (hello.name ?? "Unbekannt").slice(0, 24) };
    if (peer.id && knownPeers()[peer.id]) {
      acceptPeer(peer);
      status(`${peer.name} (bekannt) beigetreten`);
    } else {
      pendingHello = peer;
      el.jrText.textContent = `„${peer.name}" möchte der Session beitreten.`;
      el.joinBanner.hidden = false;
    }
  } else if (type === MSG_WELCOME) {
    if (mode !== "joined") return;
    authorized = true;
    sendHandshake();
    status("Beitritt bestätigt");
  } else if (type === MSG_REJECT) {
    if (mode !== "joined") return;
    status("Der Host hat den Beitritt abgelehnt", true);
    void leaveSession();
  } else if (type === MSG_META) {
    const guid = decoding.readVarString(dec);
    if (mode !== "joined") return;
    if (hostGuid === null) {
      hostGuid = guid;
    } else if (hostGuid !== guid) {
      // Host teilt inzwischen ein ANDERES Dokument: Merge wäre Historien-Mix
      // (Verdopplungs-Anti-Pattern) — Gast adoptiert stattdessen frisch.
      hostGuid = guid;
      resetDoc("");
      currentPath = null;
      guestBaselinePending = true;
      el.fileLabel.textContent = "(Session-Dokument)";
      wireDoc();
      sendHandshake();
      status("Host teilt ein neues Dokument — Stand übernommen");
    }
  }
}

function clearRemoteAwareness() {
  const remote = [...awareness.getStates().keys()].filter(
    (id) => id !== ydoc.clientID,
  );
  if (remote.length > 0) {
    awarenessProtocol.removeAwarenessStates(awareness, remote, "remote");
  }
}

// --- Editor ---

function mountEditor() {
  view?.destroy();
  awareness.setLocalStateField("user", localUser());
  const state = EditorState.create({
    doc: ytext.toString(),
    extensions: [
      keymap.of(yUndoManagerKeymap),
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(ytext, awareness, { undoManager }),
      authorColoring(() => ytext),
    ],
  });
  view = new EditorView({ state, parent: el.editor });
}

function resetDoc(contents: string) {
  // Frischer Doc: kein Merge mit Vorzustand, daher kein Full-Replace-Anti-Pattern —
  // es existiert keine geteilte Historie mit dem neuen Doc.
  awareness.destroy();
  ydoc.destroy();
  wiredFor = null;
  authorNames.clear();
  clearBaseline();
  ydoc = new Y.Doc();
  ytext = ydoc.getText("content");
  if (contents.length > 0) ytext.insert(0, contents);
  awareness = new Awareness(ydoc);
  undoManager = new Y.UndoManager(ytext);
  registerDocObservers();
  mountEditor();
  updateLegend();
}

// --- Datei ---

async function openFile() {
  if (mode !== "idle") {
    status("Während einer Session nicht möglich — erst Session beenden", true);
    return;
  }
  const path = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
  });
  if (typeof path !== "string") return;
  try {
    const contents = await invoke<string>("read_file", { path });
    resetDoc(contents);
    currentPath = path;
    el.fileLabel.textContent = path;
    status("Geöffnet");
  } catch (e) {
    status(String(e), true);
  }
}

async function saveFile() {
  let path = currentPath;
  if (!path) {
    const chosen = await save({
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof chosen !== "string") return;
    path = chosen;
  }
  try {
    await invoke("write_file", { path, contents: ytext.toString() });
    currentPath = path;
    el.fileLabel.textContent = path;
    status("Gespeichert");
    updateSaveButton();
    // Crash-Kopie ist ab jetzt überholt — leeren, damit kein stale Hinweis kommt
    if (recoveryPath) void invoke("write_file", { path: recoveryPath, contents: "" }).catch(() => {});
  } catch (e) {
    status(String(e), true);
  }
}

// Gast ohne Pfad speichert eine lokale Kopie — Button-Beschriftung sagt das ehrlich
function updateSaveButton() {
  el.save.textContent = currentPath === null && mode === "joined" ? "Kopie speichern" : "Speichern";
}

// --- Session ---

async function hostSession() {
  if (mode !== "idle") {
    // Fungiert in hosting- UND joined-Modus als "Session beenden"/"Verlassen"
    await leaveSession();
    return;
  }
  try {
    const code = await invoke<string>("host_session", {
      port: SESSION_PORT,
      name: currentName(),
      id: myId,
    });
    mode = "hosting";
    wireDoc();
    // Session-Baseline: der vorgeladene Datei-Inhalt ist Bestand, kein Autoren-Text
    captureBaseline(ydoc);
    refreshAuthorUi();
    el.sessionCode.textContent = code;
    el.sessionCode.title = "Klick: Code kopieren";
    updateSessionUi();
    status("Code an die Gegenseite geben");
  } catch (e) {
    status(String(e), true);
  }
}

async function joinSession() {
  // Host-Seite einer Internet-Session: Eingabe ist der Antwort-Code des Gasts
  if (mode === "hosting" && inetAwaitingAnswer) {
    const answer = el.joinInput.value.trim();
    if (!answer.startsWith(CODE_PREFIX)) {
      status("Antwort-Code (QL1-…) des Gasts einfügen", true);
      return;
    }
    try {
      await invoke("webrtc_finish", { code: answer });
      inetAwaitingAnswer = false;
      el.joinInput.value = "";
      updateSessionUi();
      connStatus("verbinde …");
      status("Code angenommen — ICE verhandelt die Verbindung");
    } catch (e) {
      status(String(e), true);
    }
    return;
  }

  const rejoin = mode === "joined" && !connected;
  const addr = rejoin ? lastJoinedAddr! : el.joinInput.value.trim();

  // Internet-Gast: QL1-Offer-Code statt ip:port
  if (!rejoin && addr.startsWith(CODE_PREFIX)) {
    resetDoc("");
    currentPath = null;
    hostGuid = null;
    guestBaselinePending = true;
    el.fileLabel.textContent = "(Session-Dokument)";
    mode = "joined";
    wireDoc();
    updateSessionUi();
    try {
      status("Erzeuge Antwort-Code … (STUN-Abfrage, wenige Sekunden)");
      const answer = await invoke<string>("webrtc_accept", { code: addr });
      lastJoinedAddr = addr;
      el.joinInput.value = "";
      copyCode(answer, "Antwort-Code");
      connStatus("warte auf Host …");
    } catch (e) {
      mode = "idle";
      updateSessionUi();
      status(String(e), true);
    }
    return;
  }
  if (rejoin && lastJoinedAddr?.startsWith(CODE_PREFIX)) {
    status("Internet-Session braucht einen frischen Code — verlassen und neu beitreten", true);
    return;
  }

  if (!addr || !addr.includes(":")) {
    status("Adresse als ip:port eingeben (oder QL1-Code einfügen)", true);
    return;
  }
  if (!rejoin) {
    // Erst-Beitritt: Gast adoptiert den Host-State — eigener Doc wird leer,
    // der Sync zieht den Inhalt. Beim Re-Join derselben Session dagegen KEIN
    // Reset: geteilte Historie existiert, Offline-Edits mergen verlustfrei.
    resetDoc("");
    currentPath = null;
    hostGuid = null;
    guestBaselinePending = true;
    el.fileLabel.textContent = "(Session-Dokument)";
    mode = "joined";
    wireDoc();
  }
  updateSessionUi();
  try {
    await invoke("join_session", { addr });
    lastJoinedAddr = addr;
  } catch (e) {
    if (!rejoin) mode = "idle";
    updateSessionUi();
    status(String(e), true);
  }
}

// Host bestätigt einen Beitritt: Identität merken (TOFU), dann erst Sync starten
function acceptPeer(peer: { id: string; name: string }) {
  if (peer.id) rememberPeer(peer.id, peer.name);
  pendingHello = null;
  el.joinBanner.hidden = true;
  authorized = true;
  connStatus("verbunden");
  sendControl(MSG_WELCOME, null);
  sendHandshake();
}

function rejectPeer() {
  pendingHello = null;
  el.joinBanner.hidden = true;
  sendControl(MSG_REJECT, null);
  status("Beitritt abgelehnt — Verbindung wird getrennt");
}

async function leaveSession() {
  await invoke("leave_session").catch(() => {});
  mode = "idle";
  connected = false;
  authorized = false;
  pendingHello = null;
  el.joinBanner.hidden = true;
  hostGuid = null;
  lastJoinedAddr = null;
  guestBaselinePending = false;
  inetAwaitingAnswer = false;
  // Baseline bleibt: die Session-Färbung („wer hat was geschrieben") überlebt
  // das Session-Ende, bis eine Datei neu geöffnet wird.
  clearRemoteAwareness();
  updateSessionUi();
  connStatus("offline");
  status("");
}

// --- Events vom Backend ---

void listen<number[]>("net-recv", (e) => {
  handleIncoming(Uint8Array.from(e.payload));
});

void listen<{ fullname: string; label: string; addr: string; id: string }>(
  "lan-found",
  (e) => {
    lanHosts.set(e.payload.fullname, e.payload);
    renderLanList();
  },
);
void listen<string>("lan-removed", (e) => {
  lanHosts.delete(e.payload);
  renderLanList();
});

void listen<string>("net-status", (e) => {
  const s = e.payload;
  if (s === "connected") {
    connected = true;
    authorized = false;
    inetAwaitingAnswer = false;
    updateSessionUi();
    if (mode === "joined") {
      connStatus("warte auf Bestätigung des Hosts …");
      sendControl(MSG_HELLO, { id: myId, name: currentName() });
    } else {
      connStatus("Gast verbindet …");
    }
  } else if (s === "listening") {
    connected = false;
    connStatus("wartet auf Peer …");
  } else if (s === "disconnected") {
    connected = false;
    authorized = false;
    pendingHello = null;
    el.joinBanner.hidden = true;
    clearRemoteAwareness();
    if (mode === "hosting") {
      connStatus("wartet auf Peer …");
    } else if (mode === "joined") {
      connStatus("getrennt");
      status("Verbindung verloren — „Erneut verbinden“ merged deine Änderungen", true);
    }
    updateSessionUi();
  } else if (s === "offline") {
    connected = false;
    connStatus("offline");
  }
});

// --- UI-Verkabelung ---

// Internet-Session (Host): Offer-Code erzeugen und teilen
async function hostInternet() {
  if (mode !== "idle") {
    status("Erst die aktuelle Session beenden", true);
    return;
  }
  try {
    status("Erzeuge Internet-Code … (STUN-Abfrage, wenige Sekunden)");
    const code = await invoke<string>("webrtc_offer");
    mode = "hosting";
    inetAwaitingAnswer = true;
    wireDoc();
    captureBaseline(ydoc);
    refreshAuthorUi();
    updateSessionUi();
    connStatus("warte auf Antwort-Code …");
    copyCode(code, "Internet-Code");
  } catch (e) {
    status(String(e), true);
  }
}

el.open.addEventListener("click", openFile);
el.save.addEventListener("click", saveFile);
el.host.addEventListener("click", hostSession);
el.inet.addEventListener("click", hostInternet);
el.join.addEventListener("click", joinSession);
el.colorsToggle.addEventListener("click", () => {
  const on = toggleColoring();
  el.colorsToggle.textContent = on ? "Farben aus" : "Farben an";
  refreshAuthorUi();
});
el.nameInput.value = localStorage.getItem(NAME_STORAGE_KEY) ?? "";
el.nameInput.addEventListener("change", () => {
  localStorage.setItem(NAME_STORAGE_KEY, el.nameInput.value.trim());
  awareness.setLocalStateField("user", localUser());
  updateLegend();
});
el.sessionCode.addEventListener("click", () => {
  const code = el.sessionCode.textContent;
  if (code) {
    void navigator.clipboard.writeText(code).then(
      () => status("Code kopiert"),
      () => status("Kopieren fehlgeschlagen — Code manuell abtippen", true),
    );
  }
});
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    void saveFile();
  }
});

// Einfüge-Automatik: QL1-Code irgendwo im Fenster einfügen (Strg+V) genügt —
// die App erkennt ihn und tut das Richtige (beitreten bzw. Antwort verbinden).
// Nicht im Editor abfangen: dort könnte man einen Code auch als TEXT einfügen wollen.
window.addEventListener("paste", (e) => {
  const target = e.target as HTMLElement | null;
  if (target && el.editor.contains(target)) return;
  const text = e.clipboardData?.getData("text")?.trim() ?? "";
  if (!text.startsWith(CODE_PREFIX)) return;
  e.preventDefault();
  el.joinInput.value = text;
  const canAct =
    mode === "idle" || (mode === "hosting" && inetAwaitingAnswer);
  if (canAct) {
    status("Code erkannt — verbinde …");
    void joinSession();
  } else {
    status("Code erkannt, aber aktuelle Session blockiert — erst beenden", true);
  }
});

updateSessionUi();
registerDocObservers();
mountEditor();

// Recovery-Pfad ermitteln; bei vorhandener Crash-Kopie Banner mit
// Wiederherstellen/Verwerfen zeigen (Realtest-Fund: Pfad-Suchen klappt nie)
async function clearRecovery() {
  if (recoveryPath) {
    await invoke("write_file", { path: recoveryPath, contents: "" }).catch(() => {});
  }
  el.recoveryBanner.hidden = true;
}

el.recover.addEventListener("click", async () => {
  if (!recoveryPath) return;
  if (mode !== "idle" || currentPath !== null || ytext.length > 0) {
    status("Wiederherstellen nur in einem leeren Fenster möglich", true);
    return;
  }
  try {
    const contents = await invoke<string>("read_file", { path: recoveryPath });
    resetDoc(contents);
    el.fileLabel.textContent = "(Wiederhergestellte Crash-Kopie — bitte speichern)";
    el.recoveryBanner.hidden = true;
    status("Crash-Kopie wiederhergestellt");
  } catch (e) {
    status(String(e), true);
  }
});

el.recoverDismiss.addEventListener("click", () => void clearRecovery());
el.jrAccept.addEventListener("click", () => {
  if (pendingHello) acceptPeer(pendingHello);
});
el.jrReject.addEventListener("click", rejectPeer);

// mDNS-Discovery aktivieren (best effort — ohne sie fehlt nur die LAN-Liste)
void invoke("lan_init").catch(() => {});

void invoke<string>("recovery_file_path")
  .then(async (p) => {
    recoveryPath = p;
    try {
      const leftover = await invoke<string>("read_file", { path: p });
      if (leftover.trim().length > 0) el.recoveryBanner.hidden = false;
    } catch {
      // keine Crash-Kopie — Normalfall
    }
  })
  .catch(() => {});
