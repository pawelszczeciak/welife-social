// Testy na atrapie Graph API (lokalny serwer HTTP): przypadek poprawny, odrzucany
// i zachowanie sąsiednie (próba, przyszły termin, termin przeterminowany, ponowienie).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../scripts/publish.mjs";
import { check } from "../scripts/check-config.mjs";

async function mockGraph({ failPublish = 0 } = {}) {
  const calls = [];
  let n = 0;
  let fails = failPublish;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const params = Object.fromEntries(req.method === "GET" ? url.searchParams : new URLSearchParams(body));
    calls.push({ method: req.method, path: url.pathname, params });
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/files/")) return res.writeHead(206).end("x");
    if (url.pathname.startsWith("/missing/")) return res.writeHead(404).end();
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    if (p === "IG/media") return send(200, { id: `c${++n}` });
    if (p === "IG/media_publish") {
      if (fails > 0) {
        fails--;
        return send(400, { error: { message: "Temporary error", code: 2 } });
      }
      return send(200, { id: `m${++n}` });
    }
    if (p === "PAGE" && params.fields === "access_token") return send(200, { access_token: "PAGE_TOKEN" });
    if (p === "PAGE/videos" || p === "PAGE/feed" || p === "PAGE/photos") return send(200, { id: `fb${++n}` });
    if (p === "debug_token") return send(200, { data: { is_valid: true, expires_at: 0, scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "pages_manage_posts"] } });
    if (p === "PAGE") return send(200, { name: "WE.LIFE", instagram_business_account: { id: "IG", username: "welife.world" } });
    if (/^c\d+$/.test(p)) return send(200, { status_code: "FINISHED" });
    if (/^m\d+$/.test(p)) return send(200, { permalink: `https://www.instagram.com/reel/${p}/` });
    send(404, { error: { message: `unknown ${p}` } });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => server.close() };
}

const BETA = "Napisz PLAN, wyślemy link. To wersja beta (testowa).";

function fixture(posts) {
  const root = mkdtempSync(join(tmpdir(), "social-"));
  for (const d of ["queue", "state", "media"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "media", "R1.mp4"), "x");
  writeFileSync(join(root, "media", "a.jpg"), "x");
  writeFileSync(join(root, "media", "b.jpg"), "x");
  for (const p of posts) writeFileSync(join(root, "queue", `${p.id}.json`), JSON.stringify(p));
  return root;
}

const reel = (over = {}) => ({
  id: "r1", publish_at: "2026-11-02T18:30:00+01:00", platforms: ["instagram", "facebook"], type: "reel",
  media: ["media/R1.mp4"], caption: BETA, ...over,
});

function env(g, over = {}) {
  return {
    PUBLISH_LIVE: "true", META_ACCESS_TOKEN: "SECRET_TOKEN", IG_USER_ID: "IG", FB_PAGE_ID: "PAGE",
    GRAPH_BASE: g.base, MEDIA_BASE_URL: `${g.base}/files/`, NOW: "2026-11-02T18:40:00+01:00", ...over,
  };
}
const quiet = { log: () => {}, waitOpts: { intervalMs: 1 } };
const state = (root) => JSON.parse(readFileSync(join(root, "state", "published.json"), "utf8"));

test("publikuje należną rolkę na IG i FB, zapisuje stan i nie powtarza publikacji", async () => {
  const g = await mockGraph();
  const root = fixture([reel()]);
  const r = await run(env(g), { root, ...quiet });
  assert.equal(r.failures, 0);
  const s = state(root);
  assert.equal(s["r1:instagram"].status, "published");
  assert.equal(s["r1:instagram"].permalink.startsWith("https://www.instagram.com/reel/"), true);
  assert.equal(s["r1:facebook"].status, "published");
  const media = g.calls.find((c) => c.path.endsWith("/IG/media"));
  assert.equal(media.params.media_type, "REELS");
  assert.equal(media.params.video_url, `${g.base}/files/media/R1.mp4`);
  const fbVideo = g.calls.find((c) => c.path.endsWith("/PAGE/videos"));
  assert.equal(fbVideo.params.access_token, "PAGE_TOKEN");
  const before = g.calls.length;
  await run(env(g), { root, ...quiet });
  assert.equal(g.calls.length, before, "drugi przebieg nie wywołuje API");
  g.close();
});

test("tryb próbny niczego nie wysyła i nie zapisuje stanu", async () => {
  const g = await mockGraph();
  const root = fixture([reel()]);
  writeFileSync(join(root, "state", "published.json"), "{}\n");
  await run(env(g, { PUBLISH_LIVE: undefined }), { root, ...quiet });
  assert.equal(g.calls.length, 0);
  assert.deepEqual(state(root), {});
  g.close();
});

test("post z przyszłą datą czeka, przeterminowany o ponad 24 h jest pomijany", async () => {
  const g = await mockGraph();
  const root = fixture([reel({ id: "future", publish_at: "2026-11-03T18:30:00+01:00" }), reel({ id: "old", publish_at: "2026-10-31T18:30:00+01:00" })]);
  await run(env(g), { root, ...quiet });
  const s = state(root);
  assert.equal(s["future:instagram"], undefined);
  assert.equal(s["old:instagram"].status, "skipped_stale");
  assert.equal(g.calls.length, 0);
  g.close();
});

test("odrzuca tekst z niewypełnionym {{…}} albo bez informacji o becie, bez wywołań API", async () => {
  const g = await mockGraph();
  const root = fixture([reel({ id: "ph", caption: `${BETA} Wypadło {{N}}.` }), reel({ id: "nobeta", caption: "Napisz PLAN." })]);
  const r = await run(env(g), { root, ...quiet });
  const s = state(root);
  assert.match(s["ph:instagram"].error, /\{\{/);
  assert.match(s["nobeta:facebook"].error, /beta/);
  assert.equal(r.failures, 4);
  assert.equal(g.calls.length, 0);
  g.close();
});

test("obrazy AI wymagają informacji AI w tekście; IG przyjmuje maks. 5 hashtagów", async () => {
  const g = await mockGraph();
  const root = fixture([
    reel({ id: "ai", ai_imagery: true, platforms: ["instagram"] }),
    reel({ id: "tags", platforms: ["instagram"], caption: `${BETA} #a #b #c #d #e #f` }),
  ]);
  await run(env(g), { root, ...quiet });
  const s = state(root);
  assert.match(s["ai:instagram"].error, /AI/);
  assert.match(s["tags:instagram"].error, /hashtag/);
  g.close();
});

test("błąd API: ponowienie w kolejnym przebiegu, po 3 próbach status failed", async () => {
  const g = await mockGraph({ failPublish: 5 });
  const root = fixture([reel({ platforms: ["instagram"] })]);
  for (let i = 0; i < 3; i++) await run(env(g), { root, ...quiet });
  const s = state(root);
  assert.equal(s["r1:instagram"].status, "failed");
  assert.equal(s["r1:instagram"].attempts, 3);
  assert.doesNotMatch(JSON.stringify(s), /SECRET_TOKEN/, "token nie trafia do stanu");
  g.close();
});

test("niedostępny plik pod publicznym adresem blokuje publikację", async () => {
  const g = await mockGraph();
  const root = fixture([reel({ platforms: ["facebook"] })]);
  await run(env(g, { MEDIA_BASE_URL: `${g.base}/missing/` }), { root, ...quiet });
  assert.match(state(root)["r1:facebook"].error, /niedostępny/);
  assert.equal(g.calls.filter((c) => !c.path.startsWith("/missing/")).length, 0);
  g.close();
});

test("karuzela FB: zdjęcia jako nieopublikowane, potem jeden post z załącznikami", async () => {
  const g = await mockGraph();
  const root = fixture([{ id: "k", publish_at: "2026-11-02T18:00:00+01:00", platforms: ["facebook"], type: "carousel", media: ["media/a.jpg", "media/b.jpg"], caption: BETA }]);
  await run(env(g), { root, ...quiet });
  const photos = g.calls.filter((c) => c.path.endsWith("/PAGE/photos"));
  assert.equal(photos.length, 2);
  assert.equal(photos[0].params.published, "false");
  const feed = g.calls.find((c) => c.path.endsWith("/PAGE/feed"));
  assert.equal(JSON.parse(feed.params.attached_media).length, 2);
  g.close();
});

test("check-config: token bez wygaśnięcia, strona połączona z IG", async () => {
  const g = await mockGraph();
  const r = await check({ META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base }, { log: () => {} });
  assert.deepEqual(r.problems, []);
  const wrong = await check({ META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "OTHER", GRAPH_BASE: g.base }, { log: () => {} });
  assert.match(wrong.problems[0], /nie pasuje/);
  g.close();
});
