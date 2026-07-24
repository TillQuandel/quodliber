// Vertrauensliste: Wer darf welcher Datei ohne Rückfrage beitreten?
//
// Vertrauen hängt an Peer UND Datei. Wer für ein Dokument zugelassen wurde,
// kommt nur für dieses ohne Rückfrage wieder herein — nicht für alles, was
// später einmal geteilt wird. Als Dokumentschlüssel dient der Dateipfad und
// nicht die Doc-GUID: die wechselt bei jedem Neu-Öffnen derselben Datei, ein
// darauf gestütztes Vertrauen wäre nie wiederverwendbar.
//
// Ein Tab ohne Pfad (leere Session) hat keinen stabilen Schlüssel — dort gilt
// die Bestätigung nur für die laufende Session.
//
// Grenze (v0, bewusst): Die Peer-ID ist eine Zufalls-ID ohne Kryptografie und
// damit behauptbar. Die Liste schützt gegen versehentliche Beitritte, nicht
// gegen jemanden, der eine bekannte ID gezielt vortäuscht.

const KNOWN_KEY = "quodliber-known-peers";

export interface TrustEntry {
  name: string;
  paths: string[];
}

export function knownPeers(): Record<string, TrustEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, TrustEntry> = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === "string") {
        // Altformat { id: name }: Namen übernehmen, aber ohne Datei-Freigabe —
        // solche Einträge müssen einmal neu bestätigt werden
        out[id] = { name: v, paths: [] };
      } else if (v && typeof v === "object") {
        const e = v as { name?: unknown; paths?: unknown };
        out[id] = {
          name: typeof e.name === "string" ? e.name : "Unbekannt",
          paths: Array.isArray(e.paths)
            ? e.paths.filter((p): p is string => typeof p === "string")
            : [],
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

/// Zulassung merken. Ohne Pfad wird nur der Name festgehalten — das allein
/// öffnet keine Tür, der nächste Beitritt wird wieder bestätigt.
export function rememberPeer(id: string, name: string, path: string | null) {
  const k = knownPeers();
  const entry = k[id] ?? { name, paths: [] };
  entry.name = name;
  if (path && !entry.paths.includes(path)) entry.paths.push(path);
  k[id] = entry;
  saveTrust(k);
}

/// Darf dieser Peer der gerade geteilten Datei ohne Rückfrage beitreten?
export function isTrusted(id: string, path: string | null): boolean {
  if (!id || !path) return false;
  return knownPeers()[id]?.paths.includes(path) ?? false;
}

export function forgetPeer(id: string) {
  const k = knownPeers();
  delete k[id];
  saveTrust(k);
}
