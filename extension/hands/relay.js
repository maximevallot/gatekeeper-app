// The one place the extension talks to the network: the relay, which asks Claude. Any failure comes
// back as { ok: false }, and every caller keeps the gate shut on it.
import { RELAY_URL } from "../config.js";

const TIMEOUT_MS = 15000;

export async function callRelay(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RELAY_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      credentials: "omit",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, status: res.status, error: (data && data.error) || "bad_response", scope: data && data.scope };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The time, from the relay's Date header, after this computer's clock jumped. Nothing is sent with it: a plain
 * request, no install number, no data. Returns { server, local } (ms), or null if the relay can't be reached.
 */
export async function relayTime() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const before = Date.now();
    const res = await fetch(RELAY_URL + "/", { method: "HEAD", cache: "no-store", credentials: "omit", signal: ctrl.signal });
    const after = Date.now();
    const server = Date.parse(res.headers.get("date") || "");
    // The header has whole seconds; the middle of the request is the best guess for when it was written.
    return Number.isFinite(server) ? { server: server + 500, local: Math.round((before + after) / 2) } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
