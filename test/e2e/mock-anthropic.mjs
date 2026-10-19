// A fake Anthropic Messages API for the end-to-end run, answering the way ~/gatekeeper-relay's own
// scripts/mock-anthropic.mjs does, plus one local test game (agar.io is in the built-in catalog, so the
// extension never needs to sort it), and the video judge and rules chat of milestone 3. No network, no key.
import { createServer } from "node:http";

const KINDS = { "agar.io": "games", "mygame.localhost": "games", "instagram.com": "social" };

// Text of a system prompt or message, given as a string or as content blocks (the relay caches its prompts,
// which sends them as blocks with cache_control).
const textOf = (v) => (Array.isArray(v) ? v.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n") : v ?? "");

function answer(raw) {
  const body = { ...raw, system: textOf(raw.system) };
  const user = textOf(body.messages?.[0]?.content);
  if (body.system?.includes("You sort websites")) {
    const domain = /^domain: (.+)$/m.exec(user)?.[1] ?? "";
    return { kind: KINDS[domain] ?? "other" };
  }
  if (body.system?.includes("You judge single videos")) {
    const title = /<title>(.*)<\/title>/.exec(user)?.[1] ?? "";
    // Exam mode (the relay sends "exam mode: on, for ..."): about the exam's subject or not.
    if (/exam mode: on/.test(user)) return { rule: "none", forExam: /stat|regression|econometric/i.test(title) };
    if (/lecture|explained|tutorial/i.test(title)) return { rule: /- id: (v\d+)\n  about: educational/.exec(user)?.[1] ?? "none" };
    if (/minecraft|fortnite|gameplay/i.test(title)) return { rule: /- id: (v\d+)\n  about: video games/.exec(user)?.[1] ?? "none" };
    return { rule: "none" };
  }
  if (body.system?.includes("You change the rules of Gatekeeper")) {
    const said = /<message>\n([\s\S]*)\n<\/message>/.exec(user)?.[1] ?? "";
    if (/video games/i.test(said)) {
      return {
        reply: "You gave no limit for educational videos, so they are free.",
        question: null,
        diff: [
          { op: "addVideo", site: "youtube.com", about: "video games: gameplay, let's plays, streams", except: "educational videos about games",
            minutes: 0, words: { match: ["minecraft", "fortnite", "gameplay"], except: ["lecture", "explained", "tutorial"] } },
          { op: "addVideo", site: "youtube.com", about: "educational: lectures, tutorials, explainers", except: "",
            minutes: null, words: { match: ["lecture", "explained", "tutorial"], except: [] } },
        ],
      };
    }
    // Maxime's conversation of 2026-10-17, answered the way prompts/rules.md now asks: a site's own limit.
    if (/give games 30/i.test(said)) return { reply: "Games: 30 minutes a day.", question: null, diff: [{ op: "budget", kind: "games", minutes: 30 }] };
    if (/make it 30/i.test(said)) return { reply: "lequipe.fr: 30 minutes a day.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 30 }] };
    if (/only in exam mode/i.test(said)) return { reply: "lequipe.fr: closed only in exam mode.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: null }] };
    if (/lequipe/i.test(said)) return { reply: "lequipe.fr: 15 minutes a day.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] };
    return { reply: "", question: "Which sites or videos, and how many minutes a day?", diff: [] };
  }
const message = /<message>\n([\s\S]*)\n<\/message>/.exec(user)?.[1] ?? "";
  if (body.system?.includes("You hold the key to loosening")) {
    // The key to loosening: a lecture is a reason, "school" gets one question, anything else is a no.
    if (/lecture/i.test(message)) return { decision: "allow", reply: "OK, from tomorrow morning." };
    if (/try-out/i.test(message)) return { decision: "allow", when: "now", reply: "OK: exam mode ends now." };
    if (/school/i.test(message) && /earlier question: none/.test(user)) return { decision: "ask", reply: "What changed for school?" };
    return { decision: "deny", reply: "The rule stays." };
  }
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
      // Recorded with the system prompt and messages as plain text, whichever form the relay sent.
      const sent = JSON.parse(raw || "{}");
      const body = { ...sent, system: textOf(sent.system), messages: (sent.messages || []).map((m) => ({ ...m, content: textOf(m.content) })) };
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
