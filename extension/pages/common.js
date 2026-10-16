// Shared by the pages: talking to the hands, and the words for times and minutes.

export function ask(type, body = {}) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage({ type, ...body }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (res && res.error) reject(new Error(res.error));
      else resolve(res);
    }));
}

/** "tomorrow at 4:00", "today at 4:00", or "Tue 21 Oct at 4:00". */
export function when(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(n)) / 86400e3);
  if (diff === 0) return "today at " + time;
  if (diff === 1) return "tomorrow at " + time;
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " at " + time;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}
