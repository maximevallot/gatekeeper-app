// A fake Anthropic Messages API for the end-to-end run, answering the way ~/gatekeeper-relay's own
// scripts/mock-anthropic.mjs does, plus one local test game (agar.io is in the built-in catalog, so the
// extension never needs to sort it). No network, no key.
import { createServer } from "node:http";

const KINDS = { "agar.io": "games", "mygame.localhost": "games", "instagram.com": "social" };

function answer(body) {
  const user = body.messages?.[0]?.content ?? "";
  if (body.system?.includes("You sort websites")) {
    const domain = /^domain: (.+)$/m.exec(user)?.[1] ?? "";
    return { kind: KINDS[domain] ?? "other" };
  }
  const message = /<message>\n([\s\S]*)\n<\/message>/.exec(user)?.[1] ?? "";
  if (/lecture/i.test(message)) return { decision: "allow", minutes: 30, reply: "Go get the lecture recording." };
  if (/class/i.test(message)) return { decision: "ask", minutes: 0, reply: "Which class, and what do you need?" };
  return { decision: "deny", minutes: 0, reply: "No." };
}

export function startMock(expectedKey) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ path: req.url, body });
      if (req.url !== "/v1/messages" || req.headers["x-api-key"] !== expectedKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key or path" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `msg_e2e_${requests.length}`, type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify(answer(body)) }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 800, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, close: () => server.close() })));
}
