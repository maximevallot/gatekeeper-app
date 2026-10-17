const PORT = Number(process.env.CDP_PORT || 9334);
// Tiny DevTools-protocol helper for driving the throwaway browser.
export async function targets(port = PORT) { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
export async function connect(match, port = PORT) {
  let t;
  for (let i = 0; i < 80 && !t; i++) { t = (await targets(port).catch(() => [])).find(match); if (!t) await sleep(250); }
  if (!t) throw new Error("no target");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const w = new Map(); const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } else events.push(d); };
  // A call to a target that went away (a restarted service worker) never answers: fail it after 20 s, by name.
  const send = (method, params = {}) => new Promise((r, reject) => {
    const id = ++n;
    const timer = setTimeout(() => { w.delete(id); reject(new Error(`no answer to ${method} from ${t.type} ${t.url.slice(0, 80)}`)); }, 20000);
    w.set(id, (d) => { clearTimeout(timer); r(d); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };
  return { t, send, evaluate, events, close: () => ws.close() };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
