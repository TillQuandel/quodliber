// Vertrauensliste: Wer darf welcher Datei ohne Rückfrage beitreten?
//
// Vertrauen hängt an Peer UND Datei. Wer für ein Dokument zugelassen wurde,
// kommt nur für dieses ohne Rückfrage wieder herein — nicht für alles, was
// später einmal geteilt wird. Als Dokumentschlüssel dient der Dateipfad und
// nicht die Doc-GUID: die wechselt bei jedem Neu-Öffnen derselben Datei, ein
// darauf gestütztes Vertrauen wäre nie wiederverwendbar.
//
// Eingetragen wird ausschließlich, was der Host bewusst bestätigt hat. Wechselt
// er während einer laufenden Session die Datei, bleibt der verbundene Gast
// zugelassen — er bekommt die neue Datei aber NICHT dauerhaft freigegeben.
// Sonst wüchse die Liste still mit jedem Wechsel, und ein Eintrag hieße nicht
// mehr „das habe ich entschieden".
//
// Ein Tab ohne Pfad (leere Session) hat keinen stabilen Schlüssel — dort gilt
// die Bestätigung nur für die laufende Session.
//
// Grenze (v0, bewusst): Die Peer-ID ist eine Zufalls-ID ohne Kryptografie und
// damit behauptbar. Die Liste schützt gegen versehentliche Beitritte, nicht
// gegen jemanden, der eine bekannte ID gezielt vortäuscht.

const KNOWN_KEY = "quodliber-known-peers";

export interface TrustedDoc {
  path: string;
  /** ISO-Zeitpunkt der Freigabe; leer bei Einträgen aus älteren Formaten. */
  since: string;
}

export interface TrustEntry {
  name: string;
  paths: TrustedDoc[];
}

function normalizePaths(raw: unknown): TrustedDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: TrustedDoc[] = [];
  for (const p of raw) {
    // Zwischenformat (nur Pfade, ohne Datum) bleibt lesbar
    if (typeof p === "string") {
      out.push({ path: p, since: "" });
    } else if (p && typeof p === "object") {
      const e = p as { path?: unknown; since?: unknown };
      if (typeof e.path === "string" && e.path.length > 0) {
        out.push({ path: e.path, since: typeof e.since === "string" ? e.since : "" });
      }
    }
  }
  return out;
}

export function knownPeers(): Record<string, TrustEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, TrustEntry> = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === "string") {
        // Ältestes Format { id: name }: Namen übernehmen, aber ohne Freigabe —
        // solche Einträge müssen einmal neu bestätigt werden
        out[id] = { name: v, paths: [] };
      } else if (v && typeof v === "object") {
        const e = v as { name?: unknown; paths?: unknown };
        out[id] = {
          name: typeof e.name === "string" ? e.name : "Unbekannt",
          paths: normalizePaths(e.paths),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTrust(list: Record<string, TrustEntry>) {
  localStorage.setItem(KNOWN_KEY, JSON.stringify(list));
}

/// Bestätigung merken. Ohne Pfad wird nur der Name festgehalten — das allein
/// öffnet keine Tür, der nächste Beitritt wird wieder bestätigt.
export function rememberPeer(id: string, name: string, path: string | null) {
  const k = knownPeers();
  const entry = k[id] ?? { name, paths: [] };
  entry.name = name;
  if (path && !entry.paths.some((d) => d.path === path)) {
    entry.paths.push({ path, since: new Date().toISOString() });
  }
  k[id] = entry;
  saveTrust(k);
}

/// Darf dieser Peer der gerade geteilten Datei ohne Rückfrage beitreten?
export function isTrusted(id: string, path: string | null): boolean {
  if (!id || !path) return false;
  return knownPeers()[id]?.paths.some((d) => d.path === path) ?? false;
}

/// Einzelne Datei-Freigabe zurücknehmen. War es die letzte, verschwindet der
/// Eintrag ganz — eine Person ohne Freigaben in der Liste stehen zu lassen,
/// würde nur die Frage aufwerfen, was sie dort noch darf.
export function forgetPath(id: string, path: string) {
  const k = knownPeers();
  const entry = k[id];
  if (!entry) return;
  entry.paths = entry.paths.filter((d) => d.path !== path);
  if (entry.paths.length === 0) delete k[id];
  else k[id] = entry;
  saveTrust(k);
}

export function forgetPeer(id: string) {
  const k = knownPeers();
  delete k[id];
  saveTrust(k);
}
