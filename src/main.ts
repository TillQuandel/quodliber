import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  orderedPalette,
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
// Heartbeat: beide Seiten pingen; jeder Empfang zählt als Lebenszeichen —
// bleibt der Kanal >15 s stumm, gilt er als eingeschlafen (Half-Open-TCP etc.)
const MSG_PING = 6;
// PONG mit Sequenznummer für die RTT-Anzeige (alte Clients pingen ohne
// Payload und antworten nicht — dann bleibt die Anzeige einfach leer)
const MSG_PONG = 7;
const SESSION_PORT = 41420;
const PING_MS = 5000;
const STALE_MS = 15000;
const CODE_PREFIX = "QL1-";

// Persistente Install-Identität (v0: zufällige ID, keine Kryptografie —
// spoofbar, fürs LAN-/Bekannten-Szenario akzeptiert; echte Schlüssel später)
const IDENTITY_KEY = "quodliber-id";
const KNOWN_KEY = "quodliber-known-peers";
const NAME_STORAGE_KEY = "quodliber-name";
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

// ---------------------------------------------------------------------------
// Tabs: jeder Tab trägt seinen eigenen Yjs-Kontext. Die Session teilt genau
// EINEN Tab (sessionTab); alle anderen Tabs sind rein lokal — auch beim Gast.
// ---------------------------------------------------------------------------

interface Tab {
  id: number;
  path: string | null;
  label: string | null; // Anzeige-Override (z. B. "(Wiederhergestellt)")
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  autosaveTimer: number | undefined;
  closeArmed: boolean;
  // Länge des zuletzt auf die Platte geschriebenen Standes — Grundlage für den
  // Schutz gegen automatisches Leerschreiben einer bestehenden Datei
  lastSavedLen: number;
}

let nextTabId = 1;
const tabs: Tab[] = [];
let active: Tab;
let sessionTab: Tab | null = null;

type Mode = "idle" | "hosting" | "joined";
let mode: Mode = "idle";
let connected = false;
let authorized = false;
let pendingHello: { id: string; name: string } | null = null;
let hostGuid: string | null = null;
let lastJoinedAddr: string | null = null;
let guestBaselinePending = false;
let inetAwaitingAnswer = false;
let hostTransport: "tcp" | "inet" | null = null;
let lastRecv = 0;
let pingSeq = 0;
const pingSent = new Map<number, number>();
let lastRtt: number | null = null;
let fullSessionCode: string | null = null;
let pingTimer: number | undefined;
let watchdogTimer: number | undefined;
let rejoinTimer: number | undefined;
let rejoinAttempt = 0;
const REJOIN_MAX = 6;

let view: EditorView | null = null;
let recoveryPath: string | null = null;

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
  roleInfo: document.querySelector<HTMLSpanElement>("#role-info")!,
  recoveryBanner: document.querySelector<HTMLDivElement>("#recovery-banner")!,
  recover: document.querySelector<HTMLButtonElement>("#btn-recover")!,
  recoverDismiss: document.querySelector<HTMLButtonElement>("#btn-recover-dismiss")!,
  joinBanner: document.querySelector<HTMLDivElement>("#join-banner")!,
  jrText: document.querySelector<HTMLSpanElement>("#jr-text")!,
  jrAccept: document.querySelector<HTMLButtonElement>("#btn-jr-accept")!,
  jrReject: document.querySelector<HTMLButtonElement>("#btn-jr-reject")!,
  lanList: document.querySelector<HTMLSpanElement>("#lan-list")!,
  tabbar: document.querySelector<HTMLDivElement>("#tabbar")!,
  newTab: document.querySelector<HTMLButtonElement>("#btn-new-tab")!,
  shareTab: document.querySelector<HTMLButtonElement>("#btn-share-tab")!,
  kick: document.querySelector<HTMLButtonElement>("#btn-kick")!,
  logToggle: document.querySelector<HTMLButtonElement>("#btn-log")!,
  logPanel: document.querySelector<HTMLDivElement>("#log-panel")!,
  logText: document.querySelector<HTMLPreElement>("#log-text")!,
  logCopy: document.querySelector<HTMLButtonElement>("#btn-log-copy")!,
};

// Aktuell verbundener Gast (Host-Sicht) — für Kick + Vertrauensentzug
let currentPeer: { id: string; name: string } | null = null;

function forgetPeer(id: string) {
  const k = knownPeers();
  delete k[id];
  localStorage.setItem(KNOWN_KEY, JSON.stringify(k));
}

// Autoren-Register für die Legende: clientID → Name (lebt pro Session-Doc)
const authorNames = new Map<number, string>();

function authorName(clientId: number): string {
  return authorNames.get(clientId) ?? `Autor-${clientId % 1000}`;
}

function status(msg: string, isError = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("error", isError);
}

let connBase = "offline";
function connStatus(text: string) {
  connBase = text;
  renderConnStatus();
}
function renderConnStatus() {
  el.statusConn.textContent =
    connBase === "verbunden" && lastRtt !== null
      ? `verbunden · ${Math.max(1, Math.round(lastRtt))} ms`
      : connBase;
}

// --- Log-Konsole: Ereignis-Puffer + einblendbares Panel ---
const logBuf: string[] = [];
function qlog(msg: string) {
  const ts = new Date().toLocaleTimeString();
  logBuf.push(`[${ts}] ${msg}`);
  if (logBuf.length > 500) logBuf.shift();
  if (!el.logPanel.hidden) renderLog();
}
function renderLog() {
  el.logText.textContent = logBuf.join("\n");
  el.logText.scrollTop = el.logText.scrollHeight;
}

function currentName(): string {
  const t = sessionTab ?? active;
  return el.nameInput.value.trim() || `Autor-${t.ydoc.clientID % 1000}`;
}

function localUser(tab: Tab) {
  const name = el.nameInput.value.trim() || `Autor-${tab.ydoc.clientID % 1000}`;
  const pal = paletteFor(tab.ydoc.clientID);
  authorNames.set(tab.ydoc.clientID, name);
  return { name, color: pal.color, colorLight: pal.light };
}

// --- Tab-Verwaltung ---

function tabLabel(tab: Tab): string {
  if (tab.path) {
    const parts = tab.path.split(/[\\/]/);
    return parts[parts.length - 1] || tab.path;
  }
  if (tab === sessionTab && mode === "joined") return "(Session)";
  if (tab.label) return tab.label;
  return `Neu ${tab.id}`;
}

function updateTabBar() {
  el.tabbar.querySelectorAll(".tab").forEach((n) => n.remove());
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.className = "tab" + (tab === active ? " active" : "") + (tab === sessionTab ? " shared" : "");
    const label = document.createElement("span");
    label.textContent = (tab === sessionTab ? "⇄ " : "") + tabLabel(tab);
    btn.appendChild(label);
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = tab.closeArmed ? "×?" : "×";
    close.title =
      tab === sessionTab && mode !== "idle"
        ? "Geteilter Tab — erst Session beenden"
        : tab.closeArmed
          ? "Nochmal klicken: schließt OHNE Speichern"
          : "Tab schließen";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    btn.appendChild(close);
    btn.title = tab.path ?? "";
    btn.addEventListener("click", () => switchTab(tab));
    el.tabbar.insertBefore(btn, el.newTab);
  }
}

function registerTabObservers(tab: Tab) {
  tab.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (tab === active) updateLegend();
    scheduleAutosave(tab);
    // Netz-Weiterleitung: nur der geteilte Tab synct
    if (tab !== sessionTab || origin === "remote" || !connected || !authorized) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    sendBytes(encoding.toUint8Array(enc));
  });
  // Vor dem Cursor-Rendering: `change` feuert in y-protocols vor `update`, und
  // dieser Handler wird vor dem von yCollab registriert (mountEditor läuft später)
  tab.awareness.on("change", () => sanitizeRemoteAwareness(tab));
  tab.awareness.on(
    "update",
    (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      harvestAwarenessNames(tab);
      if (tab === active) updateLegend();
      if (tab !== sessionTab || origin === "remote" || !connected || !authorized) return;
      const changed = changes.added.concat(changes.updated, changes.removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(tab.awareness, changed),
      );
      sendBytes(encoding.toUint8Array(enc));
    },
  );
}

function createTab(contents: string, path: string | null): Tab {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  if (contents.length > 0) ytext.insert(0, contents);
  const tab: Tab = {
    id: nextTabId++,
    path,
    label: null,
    ydoc,
    ytext,
    awareness: new Awareness(ydoc),
    undoManager: new Y.UndoManager(ytext),
    autosaveTimer: undefined,
    closeArmed: false,
    lastSavedLen: path ? contents.length : 0,
  };
  registerTabObservers(tab);
  tabs.push(tab);
  return tab;
}

/// Doc eines Tabs in-place ersetzen (Session-Umschwenk: GUID-Wechsel,
/// Datei-Wechsel des Hosts). Kein Merge mit Vorzustand — frische Historie.
function replaceDoc(tab: Tab, contents: string) {
  // Ausstehenden Autosave noch wegschreiben — das Doc wird gleich zerstört
  void flushAutosave(tab);
  tab.awareness.destroy();
  tab.ydoc.destroy();
  clearTimeout(tab.autosaveTimer);
  tab.autosaveTimer = undefined;
  // Der neue Inhalt entspricht dem Stand auf der Platte (Host: frisch geöffnete
  // Datei; Gast: leeres Doc) — Bezugsgröße für den Leer-Schutz mitziehen
  tab.lastSavedLen = contents.length;
  tab.ydoc = new Y.Doc();
  tab.ytext = tab.ydoc.getText("content");
  if (contents.length > 0) tab.ytext.insert(0, contents);
  tab.awareness = new Awareness(tab.ydoc);
  tab.undoManager = new Y.UndoManager(tab.ytext);
  registerTabObservers(tab);
  if (tab === sessionTab) {
    authorNames.clear();
    clearBaseline();
  }
  if (tab === active) mountEditor();
  updateTabBar();
  updateLegend();
}

function switchTab(tab: Tab) {
  if (tab === active) return;
  // Instrumentiert: ein Fehler beim Wechsel darf nie still verschluckt werden
  // (Realtest-Befund „Tabs in der Session nicht wechselbar" — Ursachensuche)
  try {
    active = tab;
    mountEditor();
    updateFileLabel();
    updateTabBar();
    updateLegend();
    updateSessionUi();
  } catch (e) {
    status(`Tab-Wechsel-Fehler: ${String(e)}`, true);
    console.error("switchTab", e);
  }
}

function closeTab(tab: Tab) {
  if (tab === sessionTab && mode !== "idle") {
    status("Geteilter Tab — erst die Session beenden", true);
    return;
  }
  // Ungespeicherten Inhalt nicht per Fehlklick verlieren: zweiter Klick nötig
  if (tab.path === null && tab.ytext.length > 0 && !tab.closeArmed) {
    tab.closeArmed = true;
    updateTabBar();
    status("Tab hat ungespeicherten Inhalt — zum Schließen nochmal × klicken", true);
    window.setTimeout(() => {
      tab.closeArmed = false;
      updateTabBar();
    }, 4000);
    return;
  }
  // Letzter leerer Tab: Schließen wäre ein No-Op mit hochzählendem "Neu N" —
  // gar nichts tun (Realtest-Fund Till)
  if (tabs.length === 1 && tab.path === null && tab.ytext.length === 0) {
    status("");
    return;
  }
  // Ausstehenden Autosave noch wegschreiben (Tabs MIT Pfad schließen sofort —
  // ohne Flush wären bis zu 2 Sekunden Tipparbeit weg)
  void flushAutosave(tab);
  tab.awareness.destroy();
  tab.ydoc.destroy();
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  if (tab === sessionTab) sessionTab = null;
  if (tabs.length === 0) {
    nextTabId = 1;
    active = createTab("", null);
  } else if (tab === active) {
    active = tabs[Math.max(0, idx - 1)];
  }
  mountEditor();
  updateFileLabel();
  updateTabBar();
  updateLegend();
  updateSessionUi();
}

function updateFileLabel() {
  el.fileLabel.textContent =
    active.path ?? (active === sessionTab && mode === "joined" ? "(Session-Dokument)" : `Neu ${active.id}`);
}

// --- Editor ---

function mountEditor() {
  view?.destroy();
  const tab = active;
  tab.awareness.setLocalStateField("user", localUser(tab));
  const state = EditorState.create({
    doc: tab.ytext.toString(),
    extensions: [
      keymap.of(yUndoManagerKeymap),
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(tab.ytext, tab.awareness, { undoManager: tab.undoManager }),
      authorColoring(
        () => tab.ytext,
        () => tab === sessionTab,
      ),
    ],
  });
  view = new EditorView({ state, parent: el.editor });
}

// --- Autoren-Legende ---

function refreshAuthorUi() {
  view?.dispatch({ effects: authorsRefresh.of(null) });
  updateLegend();
}

function updateLegend() {
  el.legend.innerHTML = "";
  const inSession = active === sessionTab;
  const runs = authorRuns(active.ytext, inSession);
  if (!coloringActive(runs, inSession)) return;
  const colors = orderedPalette(runs);
  for (const [id, pal] of colors) {
    const chip = document.createElement("span");
    chip.className = "author-chip";
    if (focusedAuthorId() === id) chip.classList.add("focused");
    chip.style.backgroundColor = pal.light;
    chip.style.borderColor = pal.color;
    chip.textContent = authorName(id);
    chip.title = "Klick: diesen Autor hervorheben";
    chip.addEventListener("click", () => {
      toggleFocus(id);
      refreshAuthorUi();
    });
    el.legend.appendChild(chip);
  }
  // Cursor-Farbe an die ordnungsbasierte Textfarbe angleichen (die Gegenseite
  // rendert unseren Cursor mit der ANGEKÜNDIGTEN Farbe — nachziehen, sobald
  // sich unsere Position in der Autoren-Reihenfolge ändert)
  const myPal = colors.get(active.ydoc.clientID);
  if (myPal) {
    const st = active.awareness.getLocalState() as { user?: { color?: string } } | null;
    if (st?.user && st.user.color !== myPal.color) {
      active.awareness.setLocalStateField("user", {
        ...st.user,
        color: myPal.color,
        colorLight: myPal.light,
      });
    }
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/// Fremde Awareness-Werte sind rohe Eingaben der Gegenseite: y-codemirror.next
/// setzt `user.color` ungeprüft in ein style-Attribut (CSS-Injection, z. B.
/// bildschirmfüllendes Overlay), der Name landet in der Legende. Vor dem
/// Rendern auf harmlose Werte zurechtstutzen — läuft am `change`-Event, das
/// vor dem Cursor-Rendering von y-codemirror.next feuert.
function sanitizeRemoteAwareness(tab: Tab) {
  for (const [id, state] of tab.awareness.getStates()) {
    if (id === tab.ydoc.clientID) continue;
    const user = (state as { user?: { name?: unknown; color?: unknown; colorLight?: unknown } }).user;
    if (!user) continue;
    const pal = paletteFor(id);
    if (typeof user.color !== "string" || !HEX_COLOR.test(user.color)) user.color = pal.color;
    if (typeof user.colorLight !== "string" || !HEX_COLOR.test(user.colorLight)) {
      user.colorLight = pal.light;
    }
    if (typeof user.name !== "string") user.name = `Autor-${id % 1000}`;
    else if (user.name.length > 24) user.name = user.name.slice(0, 24);
  }
}

function harvestAwarenessNames(tab: Tab) {
  if (tab !== sessionTab && tab !== active) return;
  for (const [id, state] of tab.awareness.getStates()) {
    const name = (state as { user?: { name?: string } }).user?.name;
    if (name) authorNames.set(id, name);
  }
}

function clearRemoteAwareness() {
  const t = sessionTab;
  if (!t) return;
  const remote = [...t.awareness.getStates().keys()].filter((id) => id !== t.ydoc.clientID);
  if (remote.length > 0) {
    awarenessProtocol.removeAwarenessStates(t.awareness, remote, "remote");
  }
}

// --- Auto-Sichern: Tab mit Pfad → in die Datei; geteilter Tab ohne Pfad
// (Gast) → Crash-Kopie im App-Datenordner.

function scheduleAutosave(tab: Tab) {
  clearTimeout(tab.autosaveTimer);
  tab.autosaveTimer = window.setTimeout(() => {
    tab.autosaveTimer = undefined;
    void autosave(tab);
  }, 2000);
}

/// Ausstehenden Autosave sofort schreiben statt verwerfen: sonst gehen bis zu
/// 2 Sekunden Tipparbeit verloren, wenn ein Tab geschlossen, das Doc ersetzt
/// oder das Fenster geschlossen wird. Der Textstand wird synchron gezogen —
/// die Aufrufer zerstören das Doc unmittelbar danach.
function flushAutosave(tab: Tab): Promise<void> {
  if (tab.autosaveTimer === undefined) return Promise.resolve();
  clearTimeout(tab.autosaveTimer);
  tab.autosaveTimer = undefined;
  return autosave(tab, tab.ytext.toString());
}

async function autosave(tab: Tab, snapshot?: string) {
  if (!tabs.includes(tab)) return;
  const text = snapshot ?? tab.ytext.toString();
  try {
    if (tab.path) {
      // Eine bestehende Datei nie automatisch leeren: die Gegenseite kann den
      // Text komplett löschen, und fremde Edits sind beim Host nicht per
      // Strg+Z zurückholbar (Undo trackt nur die eigene Origin)
      if (text.length === 0 && tab.lastSavedLen > 0) {
        status("Dokument ist leer — nicht automatisch gespeichert (Strg+S speichert bewusst)", true);
        return;
      }
      await invoke("write_file", { path: tab.path, contents: text });
      tab.lastSavedLen = text.length;
      if (tab === active && (!el.statusMsg.textContent || el.statusMsg.textContent.startsWith("Auto"))) {
        status(`Auto-gespeichert ${new Date().toLocaleTimeString()}`);
      }
    } else if (tab === sessionTab && recoveryPath && text.length > 0) {
      await invoke("write_file", { path: recoveryPath, contents: text });
    }
  } catch (e) {
    // Nicht in die Statuszeile (Tipp-Fluss), aber ins Log
    qlog(`Autosave-Fehler: ${String(e)}`);
  }
}

// --- Session-UI ---

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
  el.host.disabled = false;
  el.inet.disabled = mode !== "idle";
  el.join.disabled = (mode === "hosting" && !answerPaste) || (mode === "joined" && connected);
  el.joinInput.disabled = !(mode === "idle" || answerPaste);
  el.joinInput.placeholder = answerPaste ? "Antwort-Code (QL1-…) einfügen" : "ip:port oder QL1-Code";
  el.open.disabled = false;
  el.open.title =
    mode === "hosting" && active === sessionTab
      ? "Datei öffnen — ersetzt das geteilte Dokument für alle"
      : "Textdatei in neuem Tab öffnen";
  if (mode === "idle") el.sessionCode.textContent = "";
  el.shareTab.hidden = !(mode === "hosting" && active !== sessionTab);
  el.kick.hidden = !(mode === "hosting" && connected && authorized);
  if (mode === "hosting") {
    el.roleInfo.textContent = "Rolle: Host";
    el.roleInfo.title = "Geteilte Datei wählen ✓ · Original speichern ✓ · Gäste zulassen/ablehnen ✓ · eigene Tabs ✓";
  } else if (mode === "joined") {
    el.roleInfo.textContent = "Rolle: Gast";
    el.roleInfo.title =
      "Mittippen ✓ · Kopie speichern ✓ · eigene Tabs öffnen ✓ · geteilte Datei wählen ✗ (macht der Host)";
  } else {
    el.roleInfo.textContent = "";
    el.roleInfo.title = "";
  }
  updateSaveButton();
  renderLanList();
  updateTabBar();
}

function updateSaveButton() {
  el.save.textContent =
    active === sessionTab && mode === "joined" && !active.path ? "Kopie speichern" : "Speichern";
}

function copyCode(code: string, label: string) {
  void navigator.clipboard.writeText(code).then(
    () => status(`${label} kopiert — per Messenger an die Gegenseite senden`),
    () => {
      el.joinInput.value = code;
      status(`${label} liegt im Eingabefeld — manuell kopieren (Strg+A, Strg+C)`, true);
    },
  );
}

// --- Transport-Brücke (Bytes; Kanal dahinter: TCP oder WebRTC) ---

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

function sendHandshake() {
  const t = sessionTab;
  if (!t) return;
  if (mode === "hosting") {
    const encMeta = encoding.createEncoder();
    encoding.writeVarUint(encMeta, MSG_META);
    encoding.writeVarString(encMeta, t.ydoc.guid);
    sendBytes(encoding.toUint8Array(encMeta));
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, t.ydoc);
  sendBytes(encoding.toUint8Array(enc));
  const enc2 = encoding.createEncoder();
  encoding.writeVarUint(enc2, MSG_AWARENESS);
  encoding.writeVarUint8Array(
    enc2,
    awarenessProtocol.encodeAwarenessUpdate(t.awareness, [t.ydoc.clientID]),
  );
  sendBytes(encoding.toUint8Array(enc2));
}

function acceptPeer(peer: { id: string; name: string }) {
  if (peer.id) rememberPeer(peer.id, peer.name);
  currentPeer = peer;
  pendingHello = null;
  el.joinBanner.hidden = true;
  authorized = true;
  qlog(`Beitritt bestätigt: „${peer.name}" — Sync startet`);
  connStatus("verbunden");
  sendControl(MSG_WELCOME, null);
  sendHandshake();
  updateSessionUi();
}

function rejectPeer() {
  pendingHello = null;
  el.joinBanner.hidden = true;
  sendControl(MSG_REJECT, null);
  status("Beitritt abgelehnt — Verbindung wird getrennt");
}

function handleIncoming(data: Uint8Array) {
  const t = sessionTab;
  const dec = decoding.createDecoder(data);
  const type = decoding.readVarUint(dec);
  // Dokument-Nachrichten erst nach dem Beitritts-OK annehmen. Ohne diese
  // Sperre schreibt jeder, der den Kanal erreicht, ins geteilte Dokument —
  // ohne HELLO, ohne Bestätigung, und der Autosave trägt es in die Datei.
  // Gilt in beide Richtungen: nach „Gast trennen" ist authorized wieder false.
  if (!authorized && (type === MSG_SYNC || type === MSG_AWARENESS || type === MSG_META)) {
    qlog(`Nachricht (Typ ${type}) vor/ohne Beitritts-Bestätigung verworfen`);
    return;
  }
  if (type === MSG_SYNC) {
    if (!t) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const msgType = syncProtocol.readSyncMessage(dec, enc, t.ydoc, "remote");
    if (encoding.length(enc) > 1) sendBytes(encoding.toUint8Array(enc));
    if (guestBaselinePending && msgType === syncProtocol.messageYjsSyncStep2) {
      guestBaselinePending = false;
      captureBaseline(t.ydoc);
      refreshAuthorUi();
    }
  } else if (type === MSG_AWARENESS) {
    if (!t) return;
    awarenessProtocol.applyAwarenessUpdate(t.awareness, decoding.readVarUint8Array(dec), "remote");
  } else if (type === MSG_PING) {
    // Neue Clients pingen mit Sequenznummer → PONG für die RTT-Messung
    if (decoding.hasContent(dec)) {
      const seq = decoding.readVarUint(dec);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_PONG);
      encoding.writeVarUint(enc, seq);
      rawSend(encoding.toUint8Array(enc));
    }
    return;
  } else if (type === MSG_PONG) {
    if (decoding.hasContent(dec)) {
      const seq = decoding.readVarUint(dec);
      const t0 = pingSent.get(seq);
      if (t0 !== undefined) {
        pingSent.delete(seq);
        lastRtt = performance.now() - t0;
        renderConnStatus();
      }
    }
    return;
  } else if (type === MSG_HELLO) {
    if (mode !== "hosting") {
      // Kein stummes Verwerfen: der Anklopfende bekommt eine klare Ablehnung
      // (z. B. Geister-Listener nach Frontend-Reload)
      sendControl(MSG_REJECT, null);
      return;
    }
    let hello: { id?: string; name?: string };
    try {
      hello = JSON.parse(decoding.readVarString(dec)) as { id?: string; name?: string };
    } catch {
      return;
    }
    const peer = { id: hello.id ?? "", name: (hello.name ?? "Unbekannt").slice(0, 24) };
    qlog(`HELLO von „${peer.name}"`);
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
    qlog("WELCOME vom Host — Sync startet");
    sendHandshake();
    connStatus("verbunden");
    updateSessionUi();
    status("Beitritt bestätigt");
  } else if (type === MSG_REJECT) {
    if (mode !== "joined") return;
    status("Der Host hat den Beitritt abgelehnt", true);
    void leaveSession();
  } else if (type === MSG_META) {
    if (mode !== "joined" || !t) return;
    const guid = decoding.readVarString(dec);
    if (hostGuid === null) {
      hostGuid = guid;
    } else if (hostGuid !== guid) {
      // Host teilt ein ANDERES Dokument: Merge wäre Historien-Mix — frisch adoptieren
      hostGuid = guid;
      qlog("Host teilt neues Dokument (GUID-Wechsel) — adoptiere frisch");
      replaceDoc(t, "");
      t.path = null;
      guestBaselinePending = true;
      updateFileLabel();
      sendHandshake();
      status("Host teilt ein neues Dokument — Stand übernommen");
    }
  }
}

// --- Heartbeat + Auto-Reconnect ---

function startHeartbeat() {
  stopHeartbeat();
  lastRecv = Date.now();
  pingTimer = window.setInterval(() => {
    pingSeq++;
    pingSent.set(pingSeq, performance.now());
    if (pingSent.size > 20) {
      const oldest = pingSent.keys().next().value;
      if (oldest !== undefined) pingSent.delete(oldest);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_PING);
    encoding.writeVarUint(enc, pingSeq);
    rawSend(encoding.toUint8Array(enc));
  }, PING_MS);
  watchdogTimer = window.setInterval(() => {
    if (connected && Date.now() - lastRecv > STALE_MS) handleStale();
  }, 3000);
}

function stopHeartbeat() {
  clearInterval(pingTimer);
  clearInterval(watchdogTimer);
}

function cancelRejoin() {
  clearTimeout(rejoinTimer);
  rejoinAttempt = 0;
}

function scheduleRejoin() {
  if (mode !== "joined" || !lastJoinedAddr || lastJoinedAddr.startsWith(CODE_PREFIX)) return;
  if (rejoinAttempt >= REJOIN_MAX) {
    status("Automatische Wiederverbindung aufgegeben — »Erneut verbinden« versucht es manuell", true);
    return;
  }
  const delay = Math.min(2000 * 2 ** rejoinAttempt, 15000);
  rejoinAttempt++;
  connStatus(`getrennt — neuer Versuch in ${Math.round(delay / 1000)} s (${rejoinAttempt}/${REJOIN_MAX})`);
  rejoinTimer = window.setTimeout(() => {
    if (mode === "joined" && !connected) void joinSession();
  }, delay);
}

function handleStale() {
  connected = false;
  authorized = false;
  stopHeartbeat();
  clearRemoteAwareness();
  qlog(`Heartbeat: Kanal ${STALE_MS / 1000}s stumm — behandle als tot`);
  status("Verbindung eingeschlafen — stelle neu her …", true);
  if (mode === "joined") {
    void invoke("leave_session").catch(() => {});
    scheduleRejoin();
  } else if (mode === "hosting" && hostTransport === "tcp") {
    void invoke<string>("host_session", { port: SESSION_PORT, name: currentName(), id: myId })
      .then(() => connStatus("wartet auf Peer …"))
      .catch((e) => status(String(e), true));
  } else if (mode === "hosting") {
    connStatus("Internet-Session tot — neuen Code erzeugen");
  }
  updateSessionUi();
}

// --- Datei ---

async function openFile() {
  const path = await open({
    multiple: false,
    filters: [
      {
        name: "Textdateien",
        extensions: ["md", "markdown", "txt", "csv", "json", "yaml", "yml", "tex", "html", "css", "js", "ts", "py", "rs", "toml", "ini", "log"],
      },
      { name: "Alle Dateien", extensions: ["*"] },
    ],
  });
  if (typeof path !== "string") return;
  try {
    const contents = await invoke<string>("read_file", { path });
    if (mode === "hosting" && active === sessionTab) {
      // Host wechselt die geteilte Datei: Umschwenk via GUID-Handshake
      replaceDoc(sessionTab, contents);
      sessionTab.path = path;
      captureBaseline(sessionTab.ydoc);
      refreshAuthorUi();
      if (connected) sendHandshake();
      status("Geöffnet — wird in der Session geteilt");
    } else {
      // sonst: neuer Tab (leerer pfadloser aktiver Tab wird wiederverwendet)
      let tab: Tab;
      if (active.path === null && active.ytext.length === 0 && active !== sessionTab) {
        tab = active;
        replaceDoc(tab, contents);
        tab.path = path;
      } else {
        tab = createTab(contents, path);
      }
      switchTab(tab);
      status("Geöffnet");
    }
    updateFileLabel();
    updateTabBar();
  } catch (e) {
    status(String(e), true);
  }
}

async function saveFile() {
  const tab = active;
  let path = tab.path;
  if (!path) {
    const chosen = await save({
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Alle Dateien", extensions: ["*"] },
      ],
    });
    if (typeof chosen !== "string") return;
    path = chosen;
  }
  const contents = tab.ytext.toString();
  try {
    await invoke("write_file", { path, contents });
    tab.path = path;
    tab.lastSavedLen = contents.length;
    updateFileLabel();
    updateTabBar();
    status("Gespeichert");
    updateSaveButton();
    if (recoveryPath && tab === sessionTab) {
      void invoke("write_file", { path: recoveryPath, contents: "" }).catch(() => {});
    }
  } catch (e) {
    status(String(e), true);
  }
}

// --- Session ---

async function hostSession() {
  if (mode !== "idle") {
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
    hostTransport = "tcp";
    sessionTab = active;
    authorNames.clear();
    captureBaseline(sessionTab.ydoc);
    refreshAuthorUi();
    el.sessionCode.textContent = code;
    el.sessionCode.title = "Klick: Code kopieren";
    updateSessionUi();
    status("Code an die Gegenseite geben — im LAN erscheint die Session automatisch");
  } catch (e) {
    status(String(e), true);
  }
}

async function hostInternet() {
  if (mode !== "idle") {
    status("Erst die aktuelle Session beenden", true);
    return;
  }
  try {
    status("Erzeuge Internet-Code … (STUN-Abfrage, wenige Sekunden)");
    const code = await invoke<string>("webrtc_offer");
    mode = "hosting";
    hostTransport = "inet";
    inetAwaitingAnswer = true;
    sessionTab = active;
    authorNames.clear();
    captureBaseline(sessionTab.ydoc);
    refreshAuthorUi();
    updateSessionUi();
    connStatus("warte auf Antwort-Code …");
    qlog("Internet-Code erzeugt (Offer, Gathering complete)");
    // Sichtbar UND in der Zwischenablage — lautloses Kopieren wurde im
    // Remote-Test übersehen (Klick auf die Anzeige kopiert erneut)
    fullSessionCode = code;
    el.sessionCode.textContent = `${code.slice(0, 16)}… (Klick kopiert)`;
    el.sessionCode.title = "Klick: kompletten Code kopieren";
    copyCode(code, "Internet-Code");
  } catch (e) {
    status(String(e), true);
  }
}

async function joinSession() {
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

  if (!rejoin && addr.startsWith(CODE_PREFIX)) {
    const tab = createTab("", null);
    sessionTab = tab;
    switchTab(tab);
    hostGuid = null;
    guestBaselinePending = true;
    authorNames.clear();
    mode = "joined";
    updateFileLabel();
    updateSessionUi();
    try {
      status("Erzeuge Antwort-Code … (STUN-Abfrage, wenige Sekunden)");
      const answer = await invoke<string>("webrtc_accept", { code: addr });
      lastJoinedAddr = addr;
      el.joinInput.value = "";
      qlog("Antwort-Code erzeugt (Answer, Gathering complete)");
      fullSessionCode = answer;
      el.sessionCode.textContent = `${answer.slice(0, 16)}… (Klick kopiert)`;
      el.sessionCode.title = "Klick: kompletten Antwort-Code kopieren";
      copyCode(answer, "Antwort-Code");
      connStatus("warte auf Host …");
    } catch (e) {
      mode = "idle";
      sessionTab = null;
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
    const tab = createTab("", null);
    sessionTab = tab;
    switchTab(tab);
    hostGuid = null;
    guestBaselinePending = true;
    authorNames.clear();
    mode = "joined";
    updateFileLabel();
  }
  updateSessionUi();
  try {
    await invoke("join_session", { addr });
    lastJoinedAddr = addr;
  } catch (e) {
    if (!rejoin) {
      mode = "idle";
      sessionTab = null;
      status(String(e), true);
    } else {
      scheduleRejoin();
    }
    updateSessionUi();
  }
}

async function leaveSession() {
  await invoke("leave_session").catch(() => {});
  mode = "idle";
  connected = false;
  authorized = false;
  pendingHello = null;
  el.joinBanner.hidden = true;
  stopHeartbeat();
  cancelRejoin();
  hostTransport = null;
  hostGuid = null;
  lastJoinedAddr = null;
  guestBaselinePending = false;
  inetAwaitingAnswer = false;
  fullSessionCode = null;
  lastRtt = null;
  clearRemoteAwareness();
  if (sessionTab) void flushAutosave(sessionTab);
  sessionTab = null; // Tab bleibt als normaler Tab bestehen (Kopie beim Gast)
  updateFileLabel();
  updateSessionUi();
  connStatus("offline");
  status("");
}

// --- LAN-Discovery ---

const lanHosts = new Map<string, { label: string; addr: string; id: string }>();

function renderLanList() {
  el.lanList.innerHTML = "";
  if (mode !== "idle") return;
  for (const [, h] of lanHosts) {
    const chip = document.createElement("button");
    chip.className = "lan-chip";
    chip.textContent = `⌂ ${h.label}`;
    chip.title = `LAN-Session beitreten (${h.addr})`;
    chip.addEventListener("click", () => {
      el.joinInput.value = h.addr;
      void joinSession();
    });
    el.lanList.appendChild(chip);
  }
}

// --- Events vom Backend ---

void listen<number[]>("net-recv", (e) => {
  lastRecv = Date.now();
  handleIncoming(Uint8Array.from(e.payload));
});

void listen<{ fullname: string; label: string; addr: string; id: string }>("lan-found", (e) => {
  lanHosts.set(e.payload.fullname, e.payload);
  renderLanList();
});
void listen<string>("lan-removed", (e) => {
  lanHosts.delete(e.payload);
  renderLanList();
});

void listen<string>("net-log", (e) => qlog(`[rust] ${e.payload}`));

void listen<string>("net-status", (e) => {
  const s = e.payload;
  if (s === "connected") {
    connected = true;
    authorized = false;
    inetAwaitingAnswer = false;
    cancelRejoin();
    startHeartbeat();
    qlog("Kanal verbunden — Beitritts-Handshake läuft");
    updateSessionUi();
    if (mode === "joined") {
      connStatus("warte auf Bestätigung des Hosts …");
      sendControl(MSG_HELLO, { id: myId, name: currentName() });
    } else {
      connStatus("Gast verbindet …");
    }
  } else if (s === "listening") {
    connected = false;
    qlog("TCP-Listener aktiv (Port 41420) + mDNS-Ansage");
    connStatus("wartet auf Peer …");
  } else if (s === "disconnected") {
    connected = false;
    authorized = false;
    pendingHello = null;
    currentPeer = null;
    lastRtt = null;
    el.joinBanner.hidden = true;
    stopHeartbeat();
    clearRemoteAwareness();
    qlog("Verbindung getrennt");
    // Internet-Sessions sind Einmal-Material: ehrliche Meldung + sauberer
    // Leerlauf statt irreführendem "wartet auf Peer" (Remote-Test-Fund)
    const wasInetHost = mode === "hosting" && hostTransport === "inet";
    const wasInetGuest = mode === "joined" && lastJoinedAddr?.startsWith(CODE_PREFIX) === true;
    if (wasInetHost || wasInetGuest) {
      void leaveSession();
      status(
        "Internet-Verbindung fehlgeschlagen oder getrennt — neuen Code erzeugen (bei wiederholtem Scheitern: eine Seite per Handy-Hotspot)",
        true,
      );
      return;
    }
    if (mode === "hosting") {
      connStatus("wartet auf Peer …");
    } else if (mode === "joined") {
      status("Verbindung verloren — automatische Wiederverbindung läuft", true);
      scheduleRejoin();
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
el.inet.addEventListener("click", hostInternet);
el.join.addEventListener("click", joinSession);
el.newTab.addEventListener("click", () => switchTab(createTab("", null)));
el.shareTab.addEventListener("click", () => {
  if (mode !== "hosting" || active === sessionTab) return;
  // On-the-fly-Wechsel des geteilten Dokuments: Zeiger umsetzen + Handshake —
  // der Gast erkennt die neue Doc-GUID (MSG_META) und adoptiert frisch
  sessionTab = active;
  authorNames.clear();
  captureBaseline(sessionTab.ydoc);
  refreshAuthorUi();
  if (connected && authorized) sendHandshake();
  updateSessionUi();
  updateFileLabel();
  status("Dieser Tab wird jetzt geteilt");
});
el.sessionCode.addEventListener("click", () => {
  const code = fullSessionCode ?? el.sessionCode.textContent;
  if (code) copyCode(code, "Code");
});
el.colorsToggle.addEventListener("click", () => {
  const on = toggleColoring();
  el.colorsToggle.textContent = on ? "Farben aus" : "Farben an";
  refreshAuthorUi();
});
el.logToggle.addEventListener("click", () => {
  el.logPanel.hidden = !el.logPanel.hidden;
  if (!el.logPanel.hidden) renderLog();
});
el.logCopy.addEventListener("click", () => {
  void navigator.clipboard.writeText(logBuf.join("\n")).then(
    () => status("Log kopiert"),
    () => status("Log-Kopieren fehlgeschlagen", true),
  );
});
el.nameInput.value =
  sessionStorage.getItem(NAME_STORAGE_KEY) ?? localStorage.getItem(NAME_STORAGE_KEY) ?? "";
el.nameInput.addEventListener("change", () => {
  const v = el.nameInput.value.trim();
  sessionStorage.setItem(NAME_STORAGE_KEY, v);
  localStorage.setItem(NAME_STORAGE_KEY, v);
  active.awareness.setLocalStateField("user", localUser(active));
  if (sessionTab && sessionTab !== active) {
    sessionTab.awareness.setLocalStateField("user", localUser(sessionTab));
  }
  updateLegend();
});
el.jrAccept.addEventListener("click", () => {
  if (pendingHello) acceptPeer(pendingHello);
});
el.jrReject.addEventListener("click", rejectPeer);
el.kick.addEventListener("click", () => {
  if (mode !== "hosting" || !connected) return;
  const name = currentPeer?.name ?? "Gast";
  if (currentPeer?.id) forgetPeer(currentPeer.id);
  currentPeer = null;
  sendControl(MSG_REJECT, null);
  authorized = false;
  status(`${name} getrennt — beim nächsten Beitritt ist wieder deine Bestätigung nötig`);
  updateSessionUi();
  // Gast verlässt auf REJECT selbst; falls nicht (Fremd-Client), nach 2 s
  // die Verbindung host-seitig kappen und weiterlauschen
  window.setTimeout(() => {
    if (connected && mode === "hosting" && hostTransport === "tcp") {
      void invoke<string>("host_session", { port: SESSION_PORT, name: currentName(), id: myId }).catch(() => {});
    } else if (connected && mode === "hosting") {
      // Internet-Session kennt kein Weiterlauschen: den Kanal hart kappen,
      // sonst bliebe ein Gast, der das REJECT ignoriert, dauerhaft verbunden
      void leaveSession().then(() =>
        status(`${name} getrennt — Internet-Session beendet (für neue Gäste neuen Code erzeugen)`),
      );
    }
  }, 2000);
});

let recoverArmed = false;
el.recover.addEventListener("click", async () => {
  if (!recoveryPath) return;
  if ((active.path !== null || active.ytext.length > 0) && mode === "hosting" && active === sessionTab && !recoverArmed) {
    recoverArmed = true;
    el.recover.textContent = "Wirklich ersetzen?";
    status("Ersetzt das geteilte Dokument — zum Bestätigen erneut klicken", true);
    return;
  }
  try {
    const contents = await invoke<string>("read_file", { path: recoveryPath });
    recoverArmed = false;
    el.recover.textContent = "Wiederherstellen";
    el.recoveryBanner.hidden = true;
    if (mode === "hosting" && active === sessionTab) {
      replaceDoc(sessionTab, contents);
      sessionTab.path = null;
      captureBaseline(sessionTab.ydoc);
      refreshAuthorUi();
      if (connected) sendHandshake();
      status("Crash-Kopie wiederhergestellt — wird in der Session geteilt");
    } else {
      const tab = createTab(contents, null);
      tab.label = "(Wiederhergestellt)";
      switchTab(tab);
      if (mode === "idle" && lanHosts.size > 0) {
        // Vermutlich Gast nach Absturz: der Host ist noch im LAN sichtbar —
        // Wiederbeitritt holt den Live-Stand, die Kopie bleibt als Sicherung
        status("Kopie wiederhergestellt — Host ist im LAN sichtbar: Chip klicken zum Wiederbeitreten");
      } else if (mode === "idle") {
        await hostSession();
        status("Crash-Kopie wiederhergestellt — Session läuft, Gäste können beitreten");
      } else {
        status("Crash-Kopie in neuem Tab wiederhergestellt");
      }
    }
    updateFileLabel();
  } catch (e) {
    status(String(e), true);
  }
});
el.recoverDismiss.addEventListener("click", () => {
  if (recoveryPath) {
    void invoke("write_file", { path: recoveryPath, contents: "" }).catch(() => {});
  }
  el.recoveryBanner.hidden = true;
});

// Fenster-Schließen: den ausstehenden Autosave aller Tabs noch wegschreiben.
// Das Schließen darf daran nie scheitern — deshalb Zeitlimit und zwei Wege.
let closing = false;
void getCurrentWindow().onCloseRequested(async (e) => {
  if (closing) return; // zweiter Durchlauf: normal schließen lassen
  e.preventDefault();
  closing = true;
  try {
    await Promise.race([
      Promise.all(tabs.map((t) => flushAutosave(t))),
      new Promise((r) => window.setTimeout(r, 1500)),
    ]);
  } catch {
    // Ein Schreibfehler darf das Schließen nicht blockieren
  }
  const win = getCurrentWindow();
  void win.close().catch(() => void win.destroy().catch(() => {}));
});

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    void saveFile();
  }
});

window.addEventListener("paste", (e) => {
  const target = e.target as HTMLElement | null;
  if (target && el.editor.contains(target)) return;
  const text = e.clipboardData?.getData("text")?.trim() ?? "";
  if (!text.startsWith(CODE_PREFIX)) return;
  e.preventDefault();
  el.joinInput.value = text;
  const canAct = mode === "idle" || (mode === "hosting" && inetAwaitingAnswer);
  if (canAct) {
    status("Code erkannt — verbinde …");
    void joinSession();
  } else {
    status("Code erkannt, aber aktuelle Session blockiert — erst beenden", true);
  }
});

// --- Start ---

active = createTab("", null);
updateFileLabel();
updateSessionUi();
mountEditor();

// Frisches Frontend = frische Session: räumt Rust-Geisterzustand ab
// (Listener/Verbindungen überleben WebView-Reloads, der Frontend-State nicht)
void invoke("leave_session").catch(() => {});
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
