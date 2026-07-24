// Erdungstest für src/trust.ts — importiert das echte Modul (Node-Type-Stripping),
// keine nachgebaute Kopie. Geprüft wird die Kernzusage: Vertrauen gilt pro Datei,
// nicht pauschal, und ein Tab ohne Pfad öffnet keine dauerhafte Tür.
import assert from "node:assert/strict";

// localStorage-Ersatz, bevor das Modul geladen wird
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { knownPeers, rememberPeer, isTrusted, forgetPeer } = await import("../src/trust.ts");

const KEY = "quodliber-known-peers";
const DOC_A = "C:\\Texte\\roman.md";
const DOC_B = "C:\\Texte\\finanzen.md";
const PEER = "peer-1";

function reset() {
  store.clear();
}

// 1) Frisch: niemand ist vertraut
reset();
assert.equal(isTrusted(PEER, DOC_A), false, "unbekannter Peer darf nicht durch");

// 2) Zulassung für eine Datei gilt nur für diese
rememberPeer(PEER, "Testgast", DOC_A);
assert.equal(isTrusted(PEER, DOC_A), true, "zugelassene Datei muss durchlassen");
assert.equal(isTrusted(PEER, DOC_B), false, "andere Datei muss nachfragen");

// 3) Zweite Datei kommt hinzu, erste bleibt
rememberPeer(PEER, "Testgast", DOC_B);
assert.deepEqual(knownPeers()[PEER].paths, [DOC_A, DOC_B], "beide Pfade gemerkt");
assert.equal(isTrusted(PEER, DOC_A), true, "erste Datei bleibt zugelassen");

// 4) Doppelte Zulassung erzeugt keinen doppelten Eintrag
rememberPeer(PEER, "Testgast", DOC_A);
assert.equal(knownPeers()[PEER].paths.length, 2, "keine Duplikate");

// 5) Tab ohne Pfad öffnet keine dauerhafte Tür
reset();
rememberPeer(PEER, "Testgast", null);
assert.equal(knownPeers()[PEER].name, "Testgast", "Name wird trotzdem gemerkt");
assert.deepEqual(knownPeers()[PEER].paths, [], "aber keine Datei freigegeben");
assert.equal(isTrusted(PEER, null), false, "pfadloser Tab lässt nie automatisch durch");
assert.equal(isTrusted(PEER, DOC_A), false, "und öffnet auch keine andere Datei");

// 6) Entzug wirkt
reset();
rememberPeer(PEER, "Testgast", DOC_A);
forgetPeer(PEER);
assert.equal(isTrusted(PEER, DOC_A), false, "nach Entzug wieder Nachfrage");

// 7) Altformat { id: name } wird gelesen, gewährt aber keinen Zutritt
reset();
store.set(KEY, JSON.stringify({ "alt-peer": "Robo" }));
assert.equal(knownPeers()["alt-peer"].name, "Robo", "Altformat-Name übernommen");
assert.equal(isTrusted("alt-peer", DOC_A), false, "Altformat muss neu bestätigt werden");

// 8) Kaputter Speicherinhalt darf nicht sprengen
reset();
store.set(KEY, "{kein json");
assert.deepEqual(knownPeers(), {}, "defekter Speicher ergibt leere Liste");
reset();
store.set(KEY, JSON.stringify({ x: { name: 42, paths: "keine Liste" } }));
assert.deepEqual(knownPeers().x, { name: "Unbekannt", paths: [] }, "Fremdtypen abgefangen");

// 9) Leere ID darf nie durchkommen
reset();
rememberPeer("", "Namenlos", DOC_A);
assert.equal(isTrusted("", DOC_A), false, "leere ID lässt nie durch");

console.log("OK Vertrauensliste — 9 Fälle: Datei-Bindung, pfadlose Session, Entzug, Altformat, Schrott-Eingaben");
