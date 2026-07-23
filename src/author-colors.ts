import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import * as Y from "yjs";

// Deterministische Autoren-Palette: Farbe = clientID % 8 — beide Seiten rechnen
// ohne Abstimmung dieselben Farben aus. (SSoT; tools/robo-peer.mjs nutzt eigene Fixfarbe.)
export const PALETTE = [
  { color: "#30bced", light: "#30bced2e" },
  { color: "#ee6352", light: "#ee63522e" },
  { color: "#6eeb83", light: "#6eeb832e" },
  { color: "#ffa94d", light: "#ffa94d2e" },
  { color: "#9775fa", light: "#9775fa2e" },
  { color: "#f783ac", light: "#f783ac2e" },
  { color: "#66d9e8", light: "#66d9e82e" },
  { color: "#c0ca33", light: "#c0ca332e" },
];

export const paletteFor = (clientId: number) => PALETTE[clientId % PALETTE.length];

export interface AuthorRun {
  client: number;
  from: number;
  to: number;
}

/**
 * Zeichen-Attribution aus der Yjs-Item-Kette: Jedes Zeichen gehört zu einem Item
 * mit der clientID seines Autors. Liest das interne `_start`-Feld (read-only;
 * stabil in yjs 13.x, per tools/test-author-runs.mjs gegen die echte Lib geprüft).
 */
export function authorRuns(ytext: Y.Text): AuthorRun[] {
  const runs: AuthorRun[] = [];
  let pos = 0;
  let item: Y.Item | null = ytext._start;
  while (item !== null) {
    if (!item.deleted && item.countable) {
      const client = item.id.client;
      const len = item.length;
      const last = runs[runs.length - 1];
      if (last && last.client === client && last.to === pos) {
        last.to = pos + len;
      } else {
        runs.push({ client, from: pos, to: pos + len });
      }
      pos += len;
    }
    item = item.right;
  }
  return runs;
}

/**
 * CM6-Erweiterung: hinterlegt Text mit der Autorenfarbe. Erst aktiv, sobald
 * das Dokument Zeichen von mindestens zwei Autoren enthält (Solo-Tippen bleibt
 * unmarkiert). yCollab übersetzt auch Remote-Änderungen in CM-Transaktionen,
 * docChanged deckt daher beide Richtungen ab.
 */
export function authorColoring(getYText: () => Y.Text) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const runs = authorRuns(getYText());
        const clients = new Set(runs.map((r) => r.client));
        if (clients.size < 2) return Decoration.none;
        const docLen = view.state.doc.length;
        const marks = [];
        for (const r of runs) {
          // Clamp: ytext und CM-Doc sind via yCollab synchron, aber bei
          // gebatchten Remote-Updates defensiv gegen RangeErrors bleiben.
          const from = Math.min(r.from, docLen);
          const to = Math.min(r.to, docLen);
          if (to > from) {
            marks.push(
              Decoration.mark({
                attributes: {
                  style: `background-color: ${paletteFor(r.client).light}`,
                },
                class: "author-run",
              }).range(from, to),
            );
          }
        }
        return Decoration.set(marks, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
