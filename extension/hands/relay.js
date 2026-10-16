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
