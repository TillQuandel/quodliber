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
import { authorColoring, authorRuns, paletteFor } from "./author-colors";

// Nachrichten-Envelope wie bei y-websocket: [Typ-VarUint][Payload]
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Doc-GUID-Ansage: erkennt beim Re-Join, ob der Host inzwischen ein anderes
// Dokument teilt (dann muss der Gast neu adoptieren statt zu mergen)
const MSG_META = 2;
const SESSION_PORT = 41420;

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
let wiredFor: Y.Doc | null = null;
// Gast-Seite: GUID des Host-Docs aus der laufenden Session (null = keine Session)
let hostGuid: string | null = null;
let lastJoinedAddr: string | null = null;

const el = {
  open: document.querySelector<HTMLButtonElement>("#btn-open")!,
  save: document.querySelector<HTMLButtonElement>("#btn-save")!,
  host: document.querySelector<HTMLButtonElement>("#btn-host")!,
  join: document.querySelector<HTMLButtonElement>("#btn-join")!,
  joinInput: document.querySelector<HTMLInputElement>("#join-input")!,
  nameInput: document.querySelector<HTMLInputElement>("#name-input")!,
  sessionCode: document.querySelector<HTMLSpanElement>("#session-code")!,
  fileLabel: document.querySelector<HTMLDivElement>("#file-label")!,
  editor: document.querySelector<HTMLElement>("#editor")!,
  statusConn: document.querySelector<HTMLSpanElement>("#status-conn")!,
  statusMsg: document.querySelector<HTMLSpanElement>("#status-msg")!,
  legend: document.querySelector<HTMLSpanElement>("#author-legend")!,
};

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

function updateLegend() {
  const clients = new Set(authorRuns(ytext).map((r) => r.client));
  if (clients.size < 2) {
    el.legend.innerHTML = "";
    return;
  }
  el.legend.innerHTML = "";
  for (const id of clients) {
    const chip = document.createElement("span");
    chip.className = "author-chip";
    chip.style.backgroundColor = paletteFor(id).light;
    chip.style.borderColor = paletteFor(id).color;
    chip.textContent = authorName(id);
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
  ydoc.on("update", () => updateLegend());
  awareness.on("change", () => {
    harvestAwarenessNames();
    updateLegend();
  });
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
  el.host.textContent =
    mode === "hosting" ? "Session beenden" : mode === "joined" ? "Verlassen" : "Session starten";
  el.join.textContent = rejoinable ? "Erneut verbinden" : mode === "joined" ? "Verbunden" : "Beitreten";
  // Host-Button ist in jedem Modus die aktive Aktion (Starten/Beenden/Verlassen)
  el.host.disabled = false;
  el.join.disabled = mode === "hosting" || (mode === "joined" && connected);
  el.joinInput.disabled = mode !== "idle";
  el.open.disabled = mode !== "idle";
  if (mode === "idle") el.sessionCode.textContent = "";
}

// --- Transport-Brücke: Bytes rein/raus über Tauri; der Kanal dahinter ist austauschbar
// (M2: TCP, M3: WebRTC-DataChannel). Das Protokoll-Framing hier bleibt identisch.

function sendBytes(payload: Uint8Array) {
  if (!connected) return;
  void invoke("net_send", { data: Array.from(payload) }).catch(() => {});
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
    syncProtocol.readSyncMessage(dec, enc, ydoc, "remote");
    if (encoding.length(enc) > 1) sendBytes(encoding.toUint8Array(enc));
  } else if (type === MSG_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      awareness,
      decoding.readVarUint8Array(dec),
      "remote",
    );
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
  } catch (e) {
    status(String(e), true);
  }
}

// --- Session ---

async function hostSession() {
  if (mode !== "idle") {
    // Fungiert in hosting- UND joined-Modus als "Session beenden"/"Verlassen"
    await leaveSession();
    return;
  }
  try {
    const code = await invoke<string>("host_session", { port: SESSION_PORT });
    mode = "hosting";
    wireDoc();
    el.sessionCode.textContent = code;
    el.sessionCode.title = "Klick: Code kopieren";
    updateSessionUi();
    status("Code an die Gegenseite geben");
  } catch (e) {
    status(String(e), true);
  }
}

async function joinSession() {
  const rejoin = mode === "joined" && !connected;
  const addr = rejoin ? lastJoinedAddr! : el.joinInput.value.trim();
  if (!addr || !addr.includes(":")) {
    status("Adresse als ip:port eingeben", true);
    return;
  }
  if (!rejoin) {
    // Erst-Beitritt: Gast adoptiert den Host-State — eigener Doc wird leer,
    // der Sync zieht den Inhalt. Beim Re-Join derselben Session dagegen KEIN
    // Reset: geteilte Historie existiert, Offline-Edits mergen verlustfrei.
    resetDoc("");
    currentPath = null;
    hostGuid = null;
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

async function leaveSession() {
  await invoke("leave_session").catch(() => {});
  mode = "idle";
  connected = false;
  hostGuid = null;
  lastJoinedAddr = null;
  clearRemoteAwareness();
  updateSessionUi();
  connStatus("offline");
  status("");
}

// --- Events vom Backend ---

void listen<number[]>("net-recv", (e) => {
  handleIncoming(Uint8Array.from(e.payload));
});

void listen<string>("net-status", (e) => {
  const s = e.payload;
  if (s === "connected") {
    connected = true;
    connStatus("verbunden");
    status("");
    sendHandshake();
    updateSessionUi();
  } else if (s === "listening") {
    connected = false;
    connStatus("wartet auf Peer …");
  } else if (s === "disconnected") {
    connected = false;
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

el.open.addEventListener("click", openFile);
el.save.addEventListener("click", saveFile);
el.host.addEventListener("click", hostSession);
el.join.addEventListener("click", joinSession);
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

updateSessionUi();
registerDocObservers();
mountEditor();
