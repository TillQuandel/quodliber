// Erdungstest für src/author-colors.ts §authorRuns: Der Walker liest das interne
// Yjs-Feld `_start` — hier wird die ECHTE Funktion gegen die echte yjs-Lib
// geprüft (direkter Modul-Import, keine Nachbildung; sonst würde der Test nur
// seine eigene Kopie absichern und Änderungen am Produktionscode nicht bemerken):
// zwei Clients editieren verschränkt (inkl. Löschungen), dann muss die
// Run-Attribution exakt Text und Autoren-Zeichenzahlen reproduzieren.
import * as Y from "yjs";
import assert from "node:assert/strict";
import { authorRuns, captureBaseline, clearBaseline, NEUTRAL } from "../src/author-colors.ts";

// Erster Teil ohne Session-Baseline: reine Attribution über die Doc-Lebensdauer
clearBaseline();
const runsOf = (ytext) => authorRuns(ytext, false);

const sync = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

// Client A lädt Basistext, B adoptiert (wie Gast-Join), dann verschränkte Edits
const docA = new Y.Doc();
const docB = new Y.Doc();
const tA = docA.getText("content");
const tB = docB.getText("content");
tA.insert(0, "Hallo Welt, dies ist der Basistext.");
sync(docA, docB);

tB.insert(11, " [B-Einwurf mit Ümläuten]");
tA.insert(0, "A sagt: ");
sync(docA, docB);
tA.delete(0, 2); // A löscht eigenen Anfang
tB.insert(tB.length, " B-Schluss.");
sync(docA, docB);

assert.equal(tA.toString(), tB.toString(), "Konvergenz");
const text = tA.toString();
const runs = runsOf(tA);

// 1. Runs decken den Text lückenlos und überlappungsfrei ab
let pos = 0;
for (const r of runs) {
  assert.equal(r.from, pos, `Lücke/Überlapp bei ${r.from}`);
  assert.ok(r.to > r.from);
  pos = r.to;
}
assert.equal(pos, text.length, "Gesamtlänge");

// 2. Zeichen pro Autor stimmen mit den Eingaben abzüglich Löschungen überein
const count = new Map();
for (const r of runs) {
  count.set(r.client, (count.get(r.client) ?? 0) + (r.to - r.from));
}
const expectA = "Hallo Welt, dies ist der Basistext.".length + "A sagt: ".length - 2;
const expectB = " [B-Einwurf mit Ümläuten]".length + " B-Schluss.".length;
assert.equal(count.get(docA.clientID), expectA, "Zeichen von A");
assert.equal(count.get(docB.clientID), expectB, "Zeichen von B");
assert.equal(count.size, 2, "genau zwei Autoren");

// 3. Beide Replikate attribuieren identisch
const runsB = runsOf(tB);
assert.deepEqual(runs, runsB, "Attribution replikenidentisch");

console.log(`OK — ${runs.length} Runs, A=${expectA} Zeichen, B=${expectB} Zeichen, Text ${text.length} Zeichen`);

// --- Baseline-Fall: Bestand vor Session-Start wird NEUTRAL (-1) attribuiert.
// Auch hier die echte Funktion samt echter captureBaseline() — der Split eines
// die Baseline überspannenden Items ist genau die Stelle, die schon einmal
// falsch war und die eine Nachbildung nicht absichern würde.
const docC = new Y.Doc();
const docD = new Y.Doc();
const tC = docC.getText("content");
const tD = docD.getText("content");
tC.insert(0, "Bestand aus der Datei.");
// Session-Start: Baseline VOR den Session-Edits einfrieren
captureBaseline(docC);
sync(docC, docD);
tC.insert(tC.length, " C-in-Session.");
tD.insert(0, "D-in-Session: ");
sync(docC, docD);

const blRuns = authorRuns(tC, true);
const neutralChars = blRuns
  .filter((r) => r.client === NEUTRAL)
  .reduce((n, r) => n + (r.to - r.from), 0);
assert.equal(neutralChars, "Bestand aus der Datei.".length, "Bestand neutral");
const sessionAuthors = new Set(
  blRuns.filter((r) => r.client !== NEUTRAL).map((r) => r.client),
);
assert.equal(sessionAuthors.size, 2, "beide Session-Autoren attribuiert");
assert.ok(sessionAuthors.has(docC.clientID) && sessionAuthors.has(docD.clientID));

console.log(
  `OK Baseline — ${neutralChars} Zeichen Bestand neutral, ${sessionAuthors.size} Session-Autoren`,
);
