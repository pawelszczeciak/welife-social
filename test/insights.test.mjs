// Statystyki: pełny odczyt, zejście do samych liczników bez uprawnień do insights, i sąsiednie zachowanie
// (post spoza kolejki, jeden wiersz historii na dzień, żadnego zapisu na platformie).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeGraph } from "../scripts/lib.mjs";
import { makeZernio } from "../scripts/zernio.mjs";
import { collect, save } from "../scripts/insights.mjs";

const ins = (o) => ({ data: Object.entries(o).map(([name, value]) => ({ name, values: [{ value }] })) });

async function mock({ insights = true } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, "").replace(/^\//, "");
    const fields = url.searchParams.get("fields") ?? "";
    calls.push({ method: req.method, path: p, fields });
    const send = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
    if (req.method !== "GET") return send(500, { error: { message: "zapis w teście statystyk" } });
    if (p === "IG" ) return send(200, { username: "welife.world", followers_count: 3, media_count: 3 });
    if (p === "IG/media") {
      if (fields.includes("insights") && !insights) return send(400, { error: { message: "(#10) Application does not have permission for this action", code: 10 } });
      const withIns = fields.includes("insights");
      return send(200, { data: [
        { id: "m1", timestamp: "2026-11-05T11:37:00+0000", permalink: "https://ig/reel/1", media_type: "VIDEO", media_product_type: "REELS", like_count: 4, comments_count: 1, ...(withIns ? { insights: ins({ reach: 90, views: 120, saved: 2, shares: 1, total_interactions: 8 }) } : {}) },
        { id: "m2", timestamp: "2026-11-05T14:00:00+0000", permalink: "https://ig/reel/2", media_type: "VIDEO", media_product_type: "REELS", like_count: 0, comments_count: 0, ...(withIns ? { insights: ins({ reach: 10, views: 12, saved: 0, shares: 0, total_interactions: 0 }) } : {}) },
        { id: "m3", timestamp: "2026-11-05T07:30:00+0000", permalink: "https://ig/p/3", media_type: "IMAGE", media_product_type: "FEED", like_count: 1, comments_count: 0, ...(withIns ? { insights: ins({ reach: 20, views: 25, saved: 0, shares: 0, total_interactions: 1 }) } : {}) },
        { id: "obcy", timestamp: "2026-11-01T07:30:00+0000", media_type: "IMAGE", media_product_type: "FEED", like_count: 9, comments_count: 0 },
      ] });
    }
    if (p === "" && url.searchParams.get("ids")) return send(200, { m1: { insights: ins({ ig_reels_avg_watch_time: 6400 }), id: "m1" }, m2: { insights: ins({ ig_reels_avg_watch_time: 2100 }), id: "m2" } });
    if (p === "PAGE") return send(200, { access_token: "PAGE_TOKEN", followers_count: 5 });
    if (p === "PAGE/videos") return send(200, { data: [{ id: "v1", created_time: "2026-11-05T11:37:10+0000", views: 40, likes: { summary: { total_count: 2 } }, comments: { summary: { total_count: 0 } } }] });
    if (p === "PAGE/posts") {
      if (fields.includes("insights")) return send(400, { error: { message: "(#200) Requires read_insights", code: 200 } });
      return send(200, { data: [{ id: "PAGE_77", created_time: "2026-11-05T07:30:10+0000", shares: { count: 1 }, likes: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } }] });
    }
    if (p === "analytics") return send(200, { posts: [{ _id: "z1", publishedAt: "2026-11-05T11:37:30Z", analytics: { views: 210, likes: 3, comments: 0, shares: 1 }, platformAnalytics: [{ platform: "tiktok", platformPostUrl: "https://tt/1" }] }] });
    if (p === "analytics/tiktok/account-insights") return send(200, { metrics: { follower_count: { total: 1 } } });
    return send(404, { error: { message: "nieznana ścieżka " + p } });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, base, graph: makeGraph({ base, token: "T" }), zernio: makeZernio({ ZERNIO_API_KEY: "sk", ZERNIO_BASE: base }), close: () => server.close() };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "insights-"));
  for (const d of ["queue", "state"]) mkdirSync(join(root, d));
  const post = (id, type, at, media) => writeFileSync(join(root, "queue", `${id}.json`), JSON.stringify({ id, type, publish_at: at, platforms: ["instagram", "facebook", "tiktok"], media: [media], caption: `Pytanie ${id}?\n\nbeta` }));
  post("2026-11-05-1230-r3", "reel", "2026-11-05T12:30:00+01:00", "media/R3.mp4");
  post("2026-11-05-1500-r3-en", "reel", "2026-11-05T15:00:00+01:00", "media/R3-en.mp4");
  post("2026-11-05-0830-c1", "image", "2026-11-05T08:30:00+01:00", "media/C1.jpg");
  const pub = (id) => ({ status: "published", id });
  writeFileSync(join(root, "state", "published.json"), JSON.stringify({
    "2026-11-05-1230-r3:instagram": pub("m1"), "2026-11-05-1500-r3-en:instagram": pub("m2"), "2026-11-05-0830-c1:instagram": pub("m3"),
    "2026-11-05-1230-r3:facebook": pub("v1"), "2026-11-05-0830-c1:facebook": pub("PAGE_77"),
    "2026-11-05-1230-r3:tiktok": pub("z1"),
  }));
  return root;
}

const quiet = { log: () => {} };

test("pełny odczyt: metryki, czas oglądania, przypisanie do kolejki i podsumowanie", async () => {
  const m = await mock();
  const root = fixture();
  try {
    const d = await collect({ graph: m.graph, igUserId: "IG", pageId: "PAGE", zernio: m.zernio, env: { ZERNIO_TIKTOK_ACCOUNT_ID: "acc" }, root, now: Date.parse("2026-11-06T03:00:00Z"), ...quiet });
    const r3 = d.instagram.posts.find((p) => p.key === "2026-11-05-1230-r3");
    assert.deepEqual([r3.views, r3.reach, r3.saved, r3.avg_watch_s, r3.lang, r3.slot, r3.kind], [120, 90, 2, 6.4, "pl", "12:30", "reel"]);
    assert.equal(d.instagram.posts.find((p) => p.id === "obcy").key, null);
    assert.deepEqual(d.instagram.missing, []);
    assert.equal(d.summary.instagram.metric, "views");
    assert.equal(d.summary.instagram.by_lang.pl.median, 72.5);
    assert.equal(d.summary.instagram.by_lang.en.median, 12);
    assert.equal(d.summary.instagram.top[0].key, "2026-11-05-1230-r3");
    assert.deepEqual(d.facebook.posts.map((p) => [p.key, p.kind, p.views, p.reactions]), [["2026-11-05-1230-r3", "reel", 40, 2], ["2026-11-05-0830-c1", "image", null, 3]]);
    assert.match(d.facebook.missing.join(), /read_insights/);
    assert.deepEqual([d.tiktok.followers, d.tiktok.posts[0].key, d.tiktok.posts[0].views], [1, "2026-11-05-1230-r3", 210]);
    assert.ok(m.calls.every((c) => c.method === "GET"), "same odczyty");
    assert.ok(m.calls.length <= 9, `za dużo wywołań: ${m.calls.length}`);

    const line = save(root, d);
    save(root, d);
    assert.deepEqual([line.ig_followers, line.ig_views, line.fb_views, line.tt_views], [3, 157, 40, 210]);
    assert.equal(readFileSync(join(root, "insights", "history.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(JSON.parse(readFileSync(join(root, "insights", "latest.json"), "utf8")).instagram.followers, 3);
  } finally {
    m.close();
  }
});

test("bez uprawnień do insights: zostają polubienia i komentarze, a brak jest nazwany", async () => {
  const m = await mock({ insights: false });
  const root = fixture();
  try {
    const d = await collect({ graph: m.graph, igUserId: "IG", pageId: "PAGE", root, ...quiet });
    assert.match(d.instagram.missing.join(), /instagram_manage_insights/);
    const r3 = d.instagram.posts.find((p) => p.key === "2026-11-05-1230-r3");
    assert.deepEqual([r3.likes, r3.comments, r3.views, r3.avg_watch_s], [4, 1, null, null]);
    assert.equal(d.summary.instagram.metric, "likes");
    assert.equal(d.tiktok, undefined);
    assert.equal(m.calls.filter((c) => c.path === "IG/media").length, 2, "po odmowie uprawnień od razu wersja podstawowa");
  } finally {
    m.close();
  }
});
