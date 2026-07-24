import { StateEffect } from "@codemirror/state";
// Typen getrennt importieren: sonst kann Node sie beim Type-Stripping nicht
// entfernen und der Import scheitert — tools/test-author-runs.mjs lädt dieses
// Modul direkt, statt seine Logik nachzubauen.
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
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

/** Kollisionsfreie Farbzuordnung: Autoren nach clientID sortiert → Palette der
 * Reihe nach. Beide Replikate sehen (konvergiert) dieselbe Autorenmenge und
 * rechnen daher identische Farben; ≤8 Autoren sind garantiert verschieden. */
export function orderedPalette(runs: AuthorRun[]): Map<number, (typeof PALETTE)[number]> {
  const clients = [...new Set(runs.filter((r) => r.client !== NEUTRAL).map((r) => r.client))].sort(
    (a, b) => a - b,
  );
  const map = new Map<number, (typeof PALETTE)[number]>();
  clients.forEach((c, i) => map.set(c, PALETTE[i % PALETTE.length]));
  return map;
}

/** Signalisiert dem Editor, dass Autoren-Darstellung neu gerechnet werden muss
 * (Baseline gesetzt, Fokus gewechselt, Färbung an/aus). */
export const authorsRefresh = StateEffect.define<null>();

/** Marker für Bestand von vor der Session (wird nie gefärbt). */
export const NEUTRAL = -1;

// Session-Baseline: State-Vector zum Session-Start. Alles, was ein Client davor
// geschrieben hat (item.clock < baseline[client]), zählt als neutraler Bestand —
// gefärbt wird nur, was WÄHREND der Session entsteht (Realtest-Fund: der Host
// ist nicht "Autor" des vorgeladenen Datei-Inhalts).
let baseline: Map<number, number> | null = null;
let focusedAuthor: number | null = null;
let coloringEnabled = true;

export function captureBaseline(doc: Y.Doc) {
  baseline = Y.decodeStateVector(Y.encodeStateVector(doc));
  focusedAuthor = null;
}

export function clearBaseline() {
  baseline = null;
  focusedAuthor = null;
}

export const hasBaseline = () => baseline !== null;

export function toggleColoring(): boolean {
  coloringEnabled = !coloringEnabled;
  return coloringEnabled;
}
export const isColoringEnabled = () => coloringEnabled;

export function toggleFocus(clientId: number): number | null {
  focusedAuthor = focusedAuthor === clientId ? null : clientId;
  return focusedAuthor;
}
export const focusedAuthorId = () => focusedAuthor;

export interface AuthorRun {
  client: number;
  from: number;
  to: number;
}

/**
 * Zeichen-Attribution aus der Yjs-Item-Kette: Jedes Zeichen gehört zu einem Item
 * mit der clientID seines Autors. Nutzt das `_start`-Feld (in den Yjs-Typen
 * exponiert; per tools/test-author-runs.mjs gegen die echte Lib geerdet).
 * Mit gesetzter Baseline wird Vor-Session-Bestand als NEUTRAL ausgewiesen.
 * Achtung: Yjs verschmilzt benachbarte Items desselben Clients — ein Item kann
 * die Baseline ÜBERSPANNEN und muss dann an der Baseline-Uhr geteilt werden
 * (empirisch gefunden via tools/test-author-runs.mjs).
 */
export function authorRuns(ytext: Y.Text, useBaseline = true): AuthorRun[] {
  const bl = useBaseline ? baseline : null;
  const runs: AuthorRun[] = [];
  let pos = 0;

  const push = (client: number, len: number) => {
    const last = runs[runs.length - 1];
    if (last && last.client === client && last.to === pos) {
      last.to = pos + len;
    } else {
      runs.push({ client, from: pos, to: pos + len });
    }
    pos += len;
  };

  let item: Y.Item | null = ytext._start;
  while (item !== null) {
    if (!item.deleted && item.countable) {
      const client = item.id.client;
      const len = item.length;
      const blClock = bl?.get(client) ?? 0;
      if (bl === null || item.id.clock >= blClock) {
        push(client, len);
      } else if (item.id.clock + len <= blClock) {
        push(NEUTRAL, len);
      } else {
        // Item überspannt die Baseline: vorderen Teil neutral, Rest attribuieren
        const neutralLen = blClock - item.id.clock;
        push(NEUTRAL, neutralLen);
        push(client, len - neutralLen);
      }
    }
    item = item.right;
  }
  return runs;
}

/** Sichtbarkeitsregel: mit angewandter Session-Baseline färben ab 1 Autor
 * (Session-Tab), sonst erst ab 2 Autoren (Doc-Lebensdauer-Attribution).
 * `baselineApplied` MUSS dem useBaseline-Wert des authorRuns-Aufrufs entsprechen —
 * die globale Baseline gilt nur für den Session-Tab, nicht für fremde Tabs. */
export function coloringActive(runs: AuthorRun[], baselineApplied: boolean): boolean {
  if (!coloringEnabled) return false;
  const authors = new Set(
    runs.filter((r) => r.client !== NEUTRAL).map((r) => r.client),
  );
  return baselineApplied && baseline !== null ? authors.size >= 1 : authors.size >= 2;
}

/** CM6-Erweiterung: hinterlegt Session-Text mit der Autorenfarbe; im Fokus-Modus
 * wird ein Autor kräftig hervorgehoben und die übrigen treten zurück. */
export function authorColoring(getYText: () => Y.Text, isSessionTab: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const refreshed = u.transactions.some((t) =>
          t.effects.some((e) => e.is(authorsRefresh)),
        );
        if (u.docChanged || refreshed) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const inSession = isSessionTab();
        const runs = authorRuns(getYText(), inSession);
        if (!coloringActive(runs, inSession)) return Decoration.none;
        const colors = orderedPalette(runs);
        const docLen = view.state.doc.length;
        const marks = [];
        for (const r of runs) {
          if (r.client === NEUTRAL) continue;
          if (focusedAuthor !== null && r.client !== focusedAuthor) continue;
          const pal = colors.get(r.client) ?? paletteFor(r.client);
          const bg = focusedAuthor === r.client ? `${pal.color}55` : pal.light;
          // Clamp: ytext und CM-Doc sind via yCollab synchron, defensiv gegen
          // RangeErrors bei gebatchten Remote-Updates.
          const from = Math.min(r.from, docLen);
          const to = Math.min(r.to, docLen);
          if (to > from) {
            marks.push(
              Decoration.mark({
                attributes: { style: `background-color: ${bg}` },
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
