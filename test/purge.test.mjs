// Usuwanie starych publikacji: poprawny przebieg (Facebook przez Graph, YouTube przez Zernio), odmowa
// (Instagram nie pozwala → lista ręczna, cudzy post zostaje) i zachowanie sąsiednie (granica czasu, próba, limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeGraph } from "../scripts/lib.mjs";
import { makeZernio } from "../scripts/zernio.mjs";
import { purge, candidates } from "../scripts/purge.mjs";

const BEFORE = Date.parse("2026-11-14T01:00:00Z");
const CAP = "Stary opis rolki.\n\nKonto jest bezpłatne.";

async function mock({ igDelete = false } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, "").replace(/^\/api\/v1\//, "zernio/").replace(/^\//, "");
    calls.push({ method: req.method, path: p, token: url.searchParams.get("access_token"), json: raw && raw.startsWith("{") ? JSON.parse(raw) : null });
    const send = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
    if (p === "PAGE") return send(200, { access_token: "PAGE_TOKEN" });
    if (req.method === "DELETE" && p === "fb_gone") return send(400, { error: { message: "(#100) Object with ID 'fb_gone' does not exist", code: 100 } });
    if (req.method === "DELETE" && /^fb_/.test(p)) return send(200, { success: true });
    if (req.method === "GET" && p === "IG/media") return send(200, { data: [
      { id: "ig_old", timestamp: "2026-11-05T10:00:00+0000", permalink: "https://ig/p/old", caption: CAP },
      { id: "ig_dup", timestamp: "2026-11-05T10:05:00+0000", permalink: "https://ig/p/dup", caption: CAP },
      { id: "ig_owner", timestamp: "2026-11-11T20:24:00+0000", permalink: "https://ig/p/owner", caption: "Wrzucone ręcznie" },
      { id: "ig_new", timestamp: "2026-11-14T07:30:00+0000", permalink: "https://ig/p/new", caption: CAP },
    ] });
    if (req.method === "DELETE" && /^ig_/.test(p)) return igDelete ? send(200, { success: true }) : send(400, { error: { message: "(#3) Application does not have the capability to make this API call.", code: 3 } });
    if (req.method === "POST" && /^zernio\/posts\/[^/]+\/unpublish$/.test(p)) return send(200, { success: true, message: "ok" });
    return send(404, { error: { message: `nieznana ścieżka ${p}` } });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, graph: makeGraph({ base, token: "USER" }), zernio: makeZernio({ ZERNIO_API_KEY: "sk", ZERNIO_BASE: `${base}/api/v1` }), close: () => server.close() };
}

const pub = (id, at, extra = {}) => ({ status: "published", id, published_at: at, ...extra });
const freshState = () => ({
  "old1:facebook": pub("fb_1", "2026-11-05T10:00:00Z"),
  "old2:facebook": pub("fb_gone", "2026-11-06T10:00:00Z"),
  "new1:facebook": pub("fb_new", "2026-11-14T07:31:00Z"),
  "old1:youtube": pub("zp_1", "2026-11-13T11:56:00Z", { via: "zernio", permalink: "https://youtube.com/watch?v=1" }),
  "old1:instagram": pub("ig_old", "2026-11-05T10:00:00Z", { permalink: "https://ig/p/old" }),
  "new1:instagram": pub("ig_new", "2026-11-14T07:30:00Z"),
  "old1:tiktok": pub("zp_tt", "2026-11-05T10:00:00Z", { permalink: "https://tiktok/1" }),
  "failed1:facebook": { status: "failed", id: null },
});
const posts = [{ id: "old1", publish_at: "2026-11-05T11:00:00+01:00", caption: CAP }, { id: "new1", publish_at: "2026-11-14T08:30:00+01:00", caption: CAP }];
const base = (m, state, over = {}) => ({ before: BEFORE, state, posts, graph: m.graph, pageId: "PAGE", igUserId: "IG", zernio: m.zernio, log: () => {}, reason: "stara szata", ...over });

test("Facebook i YouTube: usuwa tylko wpisy sprzed granicy, oznacza je removed; nowe zostają", async () => {
  const m = await mock();
  const state = freshState();
  try {
    const r = await purge(base(m, state, { platforms: ["facebook", "youtube"] }));
    assert.deepEqual(r.removed.sort(), ["old1:facebook", "old1:youtube", "old2:facebook"]);
    assert.deepEqual([state["old1:facebook"].status, state["old2:facebook"].status, state["old1:youtube"].status], ["removed", "removed", "removed"]);
    assert.equal(state["old1:facebook"].note, "stara szata");
    assert.equal(state["new1:facebook"].status, "published");
    assert.equal(state["failed1:facebook"].status, "failed");
    const del = m.calls.filter((c) => c.method === "DELETE");
    assert.deepEqual(del.map((c) => [c.path, c.token]), [["fb_1", "PAGE_TOKEN"], ["fb_gone", "PAGE_TOKEN"]]);
    const yt = m.calls.find((c) => c.path === "zernio/posts/zp_1/unpublish");
    assert.deepEqual(yt.json, { platform: "youtube" });
    assert.ok(!m.calls.some((c) => c.path === "fb_new"), "nowa publikacja nietknięta");
  } finally {
    m.close();
  }
});

test("Instagram: API odmawia → nic nie jest oznaczone, lista ręczna obejmuje kopię spoza stanu, cudzy post zostaje", async () => {
  const m = await mock();
  const state = freshState();
  try {
    const r = await purge(base(m, state, { platforms: ["instagram", "tiktok"] }));
    assert.equal(state["old1:instagram"].status, "published");
    assert.deepEqual(r.manual.filter((x) => x.platform === "instagram").map((x) => x.permalink).sort(), ["https://ig/p/dup", "https://ig/p/old"]);
    assert.deepEqual(r.manual.filter((x) => x.platform === "tiktok").map((x) => x.key), ["old1:tiktok"]);
    assert.equal(m.calls.filter((c) => c.method === "DELETE").length, 1, "po pierwszej odmowie nie próbuje dalej");
    assert.ok(r.skipped.includes("instagram:ig_owner"));
    assert.ok(!m.calls.some((c) => c.path === "ig_owner" || c.path === "ig_new"));
  } finally {
    m.close();
  }
  const ok = await mock({ igDelete: true });
  const state2 = freshState();
  try {
    const r = await purge(base(ok, state2, { platforms: ["instagram"] }));
    assert.equal(state2["old1:instagram"].status, "removed");
    assert.deepEqual(ok.calls.filter((c) => c.method === "DELETE").map((c) => c.path).sort(), ["ig_dup", "ig_old"]);
    assert.ok(r.removed.includes("instagram:ig_dup"));
  } finally {
    ok.close();
  }
});

test("próba niczego nie usuwa; limit odkłada resztę na kolejny przebieg", async () => {
  const m = await mock();
  try {
    const state = freshState();
    const dry = await purge(base(m, state, { platforms: ["facebook", "youtube", "instagram"], dryRun: true }));
    assert.deepEqual([dry.removed.length, m.calls.filter((c) => c.method !== "GET").length], [0, 0]);
    assert.equal(state["old1:facebook"].status, "published");
    const limited = await purge(base(m, state, { platforms: ["facebook", "youtube"], limit: 1 }));
    assert.deepEqual(limited.removed, ["old1:facebook"]);
    assert.deepEqual(limited.skipped.sort(), ["old1:youtube", "old2:facebook"]);
    assert.deepEqual(candidates(state, posts, "facebook", BEFORE).map((c) => c.key), ["old2:facebook"]);
  } finally {
    m.close();
  }
});
