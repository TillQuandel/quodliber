import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

// --- Yjs-Kern: Der Y.Doc ist die Source of Truth, der Editor hängt via yCollab dran.
// Pro geöffneter Datei ein frischer Doc; bei Sessions (M2/M3) adoptiert der Gast den
// Host-State — nie zwei unabhängige Historien für denselben Text.
let ydoc = new Y.Doc();
let ytext = ydoc.getText("content");
let awareness = new Awareness(ydoc);
let undoManager = new Y.UndoManager(ytext);

let currentPath: string | null = null;
let view: EditorView | null = null;

const el = {
  open: document.querySelector<HTMLButtonElement>("#btn-open")!,
  save: document.querySelector<HTMLButtonElement>("#btn-save")!,
  fileLabel: document.querySelector<HTMLDivElement>("#file-label")!,
  editor: document.querySelector<HTMLElement>("#editor")!,
  statusMsg: document.querySelector<HTMLSpanElement>("#status-msg")!,
};

const USER_COLORS = [
  { color: "#30bced", light: "#30bced33" },
  { color: "#ee6352", light: "#ee635233" },
];

function localUser() {
  const idx = Math.floor(Math.random() * USER_COLORS.length);
  return { name: `Nutzer-${ydoc.clientID % 1000}`, ...USER_COLORS[idx] };
}

function status(msg: string, isError = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("error", isError);
}

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
    ],
  });
  view = new EditorView({ state, parent: el.editor });
}

function resetDoc(contents: string) {
  // Frischer Doc pro Datei-Öffnung: kein Merge mit Vorzustand, daher kein
  // Full-Replace-Anti-Pattern — es existiert noch keine geteilte Historie.
  awareness.destroy();
  ydoc.destroy();
  ydoc = new Y.Doc();
  ytext = ydoc.getText("content");
  ytext.insert(0, contents);
  awareness = new Awareness(ydoc);
  undoManager = new Y.UndoManager(ytext);
  mountEditor();
}

async function openFile() {
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

el.open.addEventListener("click", openFile);
el.save.addEventListener("click", saveFile);
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    void saveFile();
  }
});

mountEditor();
