// Erdungstest für src/author-colors.ts §authorRuns: Der Walker liest das interne
// Yjs-Feld `_start` — hier wird dieselbe Logik gegen die echte yjs-Lib geprüft:
// zwei Clients editieren verschränkt (inkl. Löschungen), dann muss die
// Run-Attribution exakt Text und Autoren-Zeichenzahlen reproduzieren.
import * as Y from "yjs";
import assert from "node:assert/strict";

function authorRuns(ytext) {
  const runs = [];
  let pos = 0;
  let item = ytext._start;
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
const runs = authorRuns(tA);

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
const runsB = authorRuns(tB);
assert.deepEqual(runs, runsB, "Attribution replikenidentisch");

console.log(`OK — ${runs.length} Runs, A=${expectA} Zeichen, B=${expectB} Zeichen, Text ${text.length} Zeichen`);

// --- Baseline-Fall: Bestand vor Session-Start wird NEUTRAL (-1) attribuiert ---
function authorRunsBaseline(ytext, baseline) {
  const runs = [];
  let pos = 0;
  const push = (client, len) => {
    const last = runs[runs.length - 1];
    if (last && last.client === client && last.to === pos) last.to = pos + len;
    else runs.push({ client, from: pos, to: pos + len });
    pos += len;
  };
  let item = ytext._start;
  while (item !== null) {
    if (!item.deleted && item.countable) {
      const client = item.id.client;
      const len = item.length;
      const blClock = baseline?.get(client) ?? 0;
      if (!baseline || item.id.clock >= blClock) push(client, len);
      else if (item.id.clock + len <= blClock) push(-1, len);
      else {
        // Item überspannt die Baseline (Yjs merged benachbarte Items!)
        const neutralLen = blClock - item.id.clock;
        push(-1, neutralLen);
        push(client, len - neutralLen);
      }
    }
    item = item.right;
  }
  return runs;
}

const docC = new Y.Doc();
const docD = new Y.Doc();
const tC = docC.getText("content");
const tD = docD.getText("content");
tC.insert(0, "Bestand aus der Datei.");
// Session-Start: Baseline VOR den Session-Edits einfrieren
const bl = Y.decodeStateVector(Y.encodeStateVector(docC));
sync(docC, docD);
tC.insert(tC.length, " C-in-Session.");
tD.insert(0, "D-in-Session: ");
sync(docC, docD);

const blRuns = authorRunsBaseline(tC, bl);
const neutralChars = blRuns
  .filter((r) => r.client === -1)
  .reduce((n, r) => n + (r.to - r.from), 0);
assert.equal(neutralChars, "Bestand aus der Datei.".length, "Bestand neutral");
const sessionAuthors = new Set(
  blRuns.filter((r) => r.client !== -1).map((r) => r.client),
);
assert.equal(sessionAuthors.size, 2, "beide Session-Autoren attribuiert");
assert.ok(sessionAuthors.has(docC.clientID) && sessionAuthors.has(docD.clientID));

console.log(
  `OK Baseline — ${neutralChars} Zeichen Bestand neutral, ${sessionAuthors.size} Session-Autoren`,
);
