// Testy na atrapie Graph API (lokalny serwer HTTP): przypadek poprawny, odrzucany
// i zachowanie sąsiednie (próba, przyszły termin, termin przeterminowany, ponowienie).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { run } from "../scripts/publish.mjs";
import { check } from "../scripts/check-config.mjs";

async function mockGraph({ failPublish = 0, bioLink = "https://welife.world/?utm_source=instagram" } = {}) {
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
    // GET /media = lista postów konta (sprawdzenie przed publikacją); tu konto bez postów.
    if (p === "IG/media" && req.method === "GET") return send(200, { data: [] });
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
    if (p === "IG") return send(200, { username: "welife.world", biography: "Plan posiłków. Wersja beta.", website: bioLink });
    if (/^c\d+$/.test(p)) return send(200, { status_code: "FINISHED" });
    if (/^m\d+$/.test(p)) return send(200, { permalink: `https://www.instagram.com/reel/${p}/` });
    send(404, { error: { message: `unknown ${p}` } });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => server.close() };
}

const BETA = "Napisz PLAN, wyślemy link. To wersja beta (testowa).";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SOUND = join(FIXTURES, "sound.mp4");

function fixture(posts) {
  const root = mkdtempSync(join(tmpdir(), "social-"));
  for (const d of ["queue", "state", "media"]) mkdirSync(join(root, d));
  cpSync(SOUND, join(root, "media", "R1.mp4"));
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
  const media = g.calls.find((c) => c.method === "POST" && c.path.endsWith("/IG/media"));
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

test("rolka cicha albo bez ścieżki dźwiękowej nie wychodzi; rolka z dźwiękiem tak", async () => {
  const g = await mockGraph();
  const root = fixture([reel({ id: "cicha", media: ["media/cicha.mp4"] }), reel({ id: "bezaudio", media: ["media/bez.mp4"] }), reel({ id: "ok" })]);
  cpSync(join(FIXTURES, "silent.mp4"), join(root, "media", "cicha.mp4"));
  cpSync(join(FIXTURES, "no-audio.mp4"), join(root, "media", "bez.mp4"));
  await run(env(g), { root, ...quiet });
  const s = state(root);
  assert.equal(s["cicha:instagram"].status, "failed");
  assert.match(s["cicha:instagram"].error, /cicha/);
  assert.match(s["bezaudio:facebook"].error, /nie ma ścieżki dźwiękowej/);
  assert.equal(s["ok:instagram"].status, "published");
  assert.ok(!g.calls.some((c) => /cicha|bez\.mp4/.test(JSON.stringify(c.params))), "ciche pliki nie idą do API");
  g.close();
});

test("wpis oznaczony jako removed nie jest publikowany ponownie", async () => {
  const g = await mockGraph();
  const root = fixture([reel()]);
  const removed = { status: "removed", id: "x", note: "usunięte, podmienione na nową wersję" };
  writeFileSync(join(root, "state", "published.json"), JSON.stringify({ "r1:instagram": removed, "r1:facebook": removed }) + "\n");
  await run(env(g), { root, ...quiet });
  assert.equal(g.calls.length, 0);
  assert.equal(state(root)["r1:instagram"].status, "removed");
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

test("check-config: brak linku do welife.world w bio IG to problem do zgłoszenia", async () => {
  const g = await mockGraph({ bioLink: "" });
  const r = await check({ META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base }, { log: () => {} });
  assert.match(r.problems.join(" "), /linku do welife\.world/);
  g.close();
});

// ── TikTok ──────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";
import { chunkPlan, readVault } from "../scripts/tiktok.mjs";
import { validate } from "../scripts/lib.mjs";

async function mockTikTok() {
  const calls = [];
  let statusPolls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const call = { method: req.method, path: url.pathname, headers: req.headers, bytes: raw.length };
    calls.push(call);
    if (url.pathname === "/v2/oauth/token/") {
      call.form = Object.fromEntries(new URLSearchParams(raw.toString()));
      return send(200, { access_token: "TT_ACCESS", expires_in: 7200, refresh_token: "TT_REFRESH_2", refresh_expires_in: 15552000, open_id: "OPEN", scope: "video.publish", token_type: "Bearer" });
    }
    if (req.headers.authorization !== "Bearer TT_ACCESS" && url.pathname.startsWith("/v2/post/")) {
      return send(401, { error: { code: "access_token_invalid", message: "bad token" } });
    }
    if (url.pathname === "/v2/post/publish/creator_info/query/") {
      return send(200, { data: { creator_username: "welife.world", privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 }, error: { code: "ok" } });
    }
    if (url.pathname === "/v2/post/publish/video/init/") {
      call.json = JSON.parse(raw.toString());
      const base = `http://127.0.0.1:${server.address().port}`;
      return send(200, { data: { publish_id: "p_1", upload_url: `${base}/upload/p_1` }, error: { code: "ok" } });
    }
    if (url.pathname === "/upload/p_1" && req.method === "PUT") return res.writeHead(201).end();
    if (url.pathname === "/v2/post/publish/status/fetch/") {
      statusPolls++;
      return send(200, { data: { status: statusPolls < 2 ? "PROCESSING_UPLOAD" : "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } });
    }
    send(404, { error: { code: "not_found" } });
  });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

const tiktokEnv = (t, over = {}) => ({
  PUBLISH_LIVE: "true", NOW: "2026-11-02T18:40:00+01:00", TIKTOK_BASE: t.base, META_ACCESS_TOKEN: "META",
  TIKTOK_CLIENT_KEY: "CK", TIKTOK_CLIENT_SECRET: "CLIENT_SECRET_X", TIKTOK_REFRESH_TOKEN: "TT_REFRESH_1",
  TIKTOK_VAULT_KEY: randomBytes(32).toString("base64"), ...over,
});
const ttReel = (over = {}) => reel({ platforms: ["tiktok"], ai_imagery: true, caption: `${BETA} Zdjęcia: ilustracje AI. #planposiłków`, ...over });

test("TikTok: odświeżenie → creator_info → init (FILE_UPLOAD) → wysyłka → status, bez tokenów w stanie", async () => {
  const t = await mockTikTok();
  const root = fixture([ttReel(), ttReel({ id: "r2", publish_at: "2026-11-02T18:35:00+01:00" })]);
  const size = readFileSync(SOUND).length;
  const e = tiktokEnv(t);
  const r = await run(e, { root, ...quiet, waitOpts: { intervalMs: 1 } });
  assert.equal(r.failures, 0);
  const s = state(root);
  assert.equal(s["r1:tiktok"].status, "published");
  assert.equal(s["r1:tiktok"].id, "p_1");
  assert.equal(s["r1:tiktok"].privacy, "SELF_ONLY");
  const tokenCalls = t.calls.filter((c) => c.path === "/v2/oauth/token/");
  assert.equal(tokenCalls.length, 1, "jeden refresh na przebieg, drugi film używa tego samego tokenu");
  assert.equal(tokenCalls[0].form.grant_type, "refresh_token");
  assert.equal(tokenCalls[0].form.refresh_token, "TT_REFRESH_1");
  const init = t.calls.find((c) => c.path === "/v2/post/publish/video/init/").json;
  assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 });
  assert.equal(init.post_info.privacy_level, "SELF_ONLY");
  assert.equal(init.post_info.is_aigc, true);
  assert.equal(init.post_info.brand_organic_toggle, true);
  assert.equal(init.post_info.disable_stitch, true, "ustawienia z creator_info są respektowane");
  const put = t.calls.find((c) => c.method === "PUT");
  assert.equal(put.headers["content-range"], `bytes 0-${size - 1}/${size}`);
  assert.equal(put.bytes, size);
  const saved = readFileSync(join(root, "state", "published.json"), "utf8");
  assert.doesNotMatch(saved, /TT_ACCESS|TT_REFRESH|CLIENT_SECRET_X/);
  const vaultRaw = readFileSync(join(root, "vault", "tiktok.json.enc"), "utf8");
  assert.doesNotMatch(vaultRaw, /TT_REFRESH_2|TT_ACCESS/, "sejf jest zaszyfrowany");
  assert.equal(readVault(root, e).refresh_token, "TT_REFRESH_2", "nowy (rotowany) refresh token zapisany");
  // Kolejny przebieg z ważnym access tokenem w sejfie nie odświeża ponownie.
  writeFileSync(join(root, "queue", "r3.json"), JSON.stringify(ttReel({ id: "r3", publish_at: "2026-11-02T18:38:00+01:00" })));
  await run(e, { root, ...quiet, waitOpts: { intervalMs: 1 } });
  assert.equal(t.calls.filter((c) => c.path === "/v2/oauth/token/").length, 1);
  assert.equal(state(root)["r3:tiktok"].status, "published");
  t.close();
});

test("TikTok przyjmuje tylko rolki", () => {
  const errors = validate({ id: "x", publish_at: "2026-11-02T19:00:00+01:00", type: "image", media: ["media/a.jpg"], caption: BETA }, "tiktok");
  assert.match(errors.join(" "), /tylko rolki/);
  assert.deepEqual(validate(ttReel(), "tiktok"), []);
});

test("bez sekretów TikTok: platforma pominięta bez błędu, reszta publikuje się normalnie", async () => {
  const g = await mockGraph();
  const root = fixture([reel({ platforms: ["instagram", "tiktok"] })]);
  const r = await run(env(g), { root, ...quiet });
  assert.equal(r.failures, 0);
  const s = state(root);
  assert.equal(s["r1:instagram"].status, "published");
  assert.equal(s["r1:tiktok"], undefined);
  g.close();
});

test("brak TIKTOK_VAULT_KEY: błąd przed odświeżeniem, więc refresh token nie przepada", async () => {
  const t = await mockTikTok();
  const root = fixture([ttReel()]);
  const r = await run(tiktokEnv(t, { TIKTOK_VAULT_KEY: "" }), { root, ...quiet });
  assert.equal(r.failures, 1);
  assert.match(state(root)["r1:tiktok"].error, /TIKTOK_VAULT_KEY/);
  assert.equal(t.calls.length, 0, "żadnego wywołania TikToka");
  t.close();
});

test("podział pliku wg zasad TikToka", () => {
  assert.deepEqual(chunkPlan(4 * 1024 * 1024), { chunkSize: 4 * 1024 * 1024, count: 1 });
  assert.deepEqual(chunkPlan(50_000_123, 10_000_000), { chunkSize: 10_000_000, count: 5 });
  assert.equal(chunkPlan(200 * 1024 * 1024, 200 * 1024 * 1024).chunkSize, 64 * 1024 * 1024);
});

test("check-config: TikTok nie skonfigurowany nie jest problemem; skonfigurowany pokazuje konto", async () => {
  const g = await mockGraph();
  const logs = [];
  const r = await check({ META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base }, { log: (l) => logs.push(l) });
  assert.deepEqual(r.problems, []);
  assert.ok(logs.includes("TikTok: nie skonfigurowany"));
  const t = await mockTikTok();
  const root = fixture([]);
  const logs2 = [];
  const r2 = await check({ META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base, ...tiktokEnv(t), TIKTOK_PRIVACY: "FOLLOWER_OF_CREATOR" }, { log: (l) => logs2.push(l), root });
  assert.ok(logs2.some((l) => l.startsWith("TikTok: @welife.world")));
  assert.match(r2.problems.join(" "), /FOLLOWER_OF_CREATOR/);
  g.close();
  t.close();
});

test("TikTok: nowy sekret TIKTOK_REFRESH_TOKEN (ponowna autoryzacja) ma pierwszeństwo przed starym sejfem", async () => {
  const t = await mockTikTok();
  const root = fixture([ttReel()]);
  const e = tiktokEnv(t);
  await run(e, { root, ...quiet, waitOpts: { intervalMs: 1 } });
  writeFileSync(join(root, "queue", "r9.json"), JSON.stringify(ttReel({ id: "r9", publish_at: "2026-11-02T18:39:00+01:00" })));
  await run({ ...e, TIKTOK_REFRESH_TOKEN: "TT_REFRESH_NEW" }, { root, ...quiet, waitOpts: { intervalMs: 1 } });
  const refreshes = t.calls.filter((c) => c.path === "/v2/oauth/token/").map((c) => c.form.refresh_token);
  assert.deepEqual(refreshes, ["TT_REFRESH_1", "TT_REFRESH_NEW"]);
  t.close();
});

// --- TikTok przez Zernio ---------------------------------------------------------------
async function mockZernio({ accounts = [{ _id: "acc_tt", platform: "tiktok", username: "welife.world" }], failPosts = 0 } = {}) {
  const calls = [];
  let fails = failPosts;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/files/")) return res.writeHead(206).end("x");
    const call = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, json: raw ? JSON.parse(raw) : null };
    calls.push(call);
    if (req.headers.authorization !== "Bearer sk_test") return send(401, { error: "invalid_credentials" });
    if (url.pathname === "/api/v1/accounts") return send(200, { accounts, hasAnalyticsAccess: false });
    if (/^\/api\/v1\/accounts\/[^/]+\/tiktok\/creator-info$/.test(url.pathname)) {
      return send(200, { creator: { nickname: "WE.LIFE", isVerified: false, canPostMore: true }, privacyLevels: [{ value: "PUBLIC_TO_EVERYONE", label: "Public" }, { value: "SELF_ONLY", label: "Only me" }] });
    }
    if (url.pathname === "/api/v1/posts" && req.method === "POST") {
      if (fails > 0) {
        fails--;
        return send(207, { message: "failed", error: "TikTok upstream error", post: { _id: "zp_fail", status: "failed", platforms: [{ platform: "tiktok", status: "failed" }] }, platformResults: [{ platform: "tiktok", status: "failed", error: "upstream" }] });
      }
      const platform = call.json?.platforms?.[0]?.platform ?? "tiktok";
      const link = platform === "youtube" ? "https://www.youtube.com/watch?v=abc123" : "https://www.tiktok.com/@welife.world/video/1";
      return send(201, { message: "ok", post: { _id: platform === "youtube" ? "zp_yt" : "zp_1", status: "published", platforms: [{ platform, status: "published", platformPostUrl: link }] } });
    }
    send(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => server.close() };
}

const zernioEnv = (z, over = {}) => ({
  PUBLISH_LIVE: "true", NOW: "2026-11-02T18:40:00+01:00", META_ACCESS_TOKEN: "META", ZERNIO_API_KEY: "sk_test",
  ZERNIO_BASE: `${z.base}/api/v1`, MEDIA_BASE_URL: `${z.base}/files/`, ...over,
});

test("Zernio: publikuje rolkę na TikToku publicznie, z oznaczeniem AI, kontem wykrytym automatycznie", async () => {
  const z = await mockZernio();
  const root = fixture([ttReel({ cover: "media/a.jpg" })]);
  const r = await run(zernioEnv(z), { root, ...quiet });
  assert.equal(r.failures, 0);
  const post = z.calls.find((c) => c.path === "/api/v1/posts");
  assert.equal(post.headers.authorization, "Bearer sk_test");
  assert.match(post.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(post.json.platforms, [{ platform: "tiktok", accountId: "acc_tt" }]);
  assert.deepEqual(post.json.mediaItems, [{ type: "video", url: `${z.base}/files/media/R1.mp4` }]);
  assert.equal(post.json.publishNow, true);
  assert.equal(post.json.tiktokSettings.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(post.json.tiktokSettings.video_made_with_ai, true);
  assert.equal(post.json.tiktokSettings.commercial_content_type, "brand_organic");
  assert.equal(post.json.tiktokSettings.video_cover_image_url, `${z.base}/files/media/a.jpg`);
  assert.match(post.json.content, /beta/);
  const s = state(root)["r1:tiktok"];
  assert.equal(s.status, "published");
  assert.equal(s.via, "zernio");
  assert.equal(s.permalink, "https://www.tiktok.com/@welife.world/video/1");
  assert.doesNotMatch(readFileSync(join(root, "state", "published.json"), "utf8"), /sk_test/);
  const before = z.calls.length;
  await run(zernioEnv(z), { root, ...quiet });
  assert.equal(z.calls.length, before, "drugi przebieg nie publikuje ponownie");
  z.close();
});

test("Zernio: ZERNIO_TIKTOK_ACCOUNT_ID pomija wyszukiwanie konta; dwa konta bez ID to czytelny błąd", async () => {
  const z = await mockZernio({ accounts: [{ _id: "a1", platform: "tiktok" }, { _id: "a2", platform: "tiktok" }] });
  const root = fixture([ttReel()]);
  await run(zernioEnv(z, { ZERNIO_TIKTOK_ACCOUNT_ID: "acc_fixed" }), { root, ...quiet });
  assert.equal(z.calls.filter((c) => c.path === "/api/v1/accounts").length, 0);
  assert.equal(z.calls.find((c) => c.path === "/api/v1/posts").json.platforms[0].accountId, "acc_fixed");
  const root2 = fixture([ttReel()]);
  await run(zernioEnv(z), { root: root2, ...quiet });
  assert.match(state(root2)["r1:tiktok"].error, /ZERNIO_TIKTOK_ACCOUNT_ID/);
  z.close();
});

test("Zernio ma pierwszeństwo przed bezpośrednim API TikToka", async () => {
  const z = await mockZernio();
  const t = await mockTikTok();
  const root = fixture([ttReel()]);
  await run({ ...tiktokEnv(t), ...zernioEnv(z) }, { root, ...quiet });
  assert.equal(t.calls.length, 0, "bez wywołań bezpośredniego API (nie rotujemy jego tokenu)");
  assert.equal(state(root)["r1:tiktok"].via, "zernio");
  z.close();
  t.close();
});

test("Zernio: błąd publikacji → ponowienie z nowym kluczem idempotencji, po 3 próbach failed", async () => {
  const z = await mockZernio({ failPosts: 5 });
  const root = fixture([ttReel()]);
  for (let i = 0; i < 3; i++) await run(zernioEnv(z), { root, ...quiet });
  const s = state(root)["r1:tiktok"];
  assert.equal(s.status, "failed");
  assert.equal(s.attempts, 3);
  assert.match(s.error, /TikTok nie opublikował/);
  const keys = z.calls.filter((c) => c.path === "/api/v1/posts").map((c) => c.headers["idempotency-key"]);
  assert.equal(new Set(keys).size, 3);
  assert.doesNotMatch(JSON.stringify(s), /sk_test/);
  z.close();
});

test("check-config: Zernio pokazuje konto TikTok; brak konta albo zła prywatność to problem", async () => {
  const g = await mockGraph();
  const z = await mockZernio();
  const meta = { META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base };
  const logs = [];
  const ok = await check({ ...meta, ZERNIO_API_KEY: "sk_test", ZERNIO_BASE: `${z.base}/api/v1` }, { log: (l) => logs.push(l) });
  assert.deepEqual(ok.problems, []);
  assert.ok(logs.some((l) => l.startsWith("TikTok (Zernio): WE.LIFE · konto acc_tt")));
  const bad = await check({ ...meta, ZERNIO_API_KEY: "sk_test", ZERNIO_BASE: `${z.base}/api/v1`, TIKTOK_PRIVACY: "FOLLOWER_OF_CREATOR" }, { log: () => {} });
  assert.match(bad.problems.join(" "), /FOLLOWER_OF_CREATOR/);
  const z0 = await mockZernio({ accounts: [] });
  const none = await check({ ...meta, ZERNIO_API_KEY: "sk_test", ZERNIO_BASE: `${z0.base}/api/v1` }, { log: () => {} });
  assert.match(none.problems.join(" "), /nie ma podłączonego konta TikTok/);
  g.close();
  z.close();
  z0.close();
});

test("Zernio: konto TikTok znalezione mimo innej wielkości liter, inne platformy pomijane", async () => {
  const z = await mockZernio({ accounts: [{ _id: "ig1", platform: "instagram" }, { _id: "tt1", platform: "TikTok", username: "welife.world" }] });
  const { findTikTokAccount, makeZernio } = await import("../scripts/zernio.mjs");
  const call = makeZernio({ ZERNIO_API_KEY: "sk_test", ZERNIO_BASE: `${z.base}/api/v1` });
  const a = await findTikTokAccount({}, call);
  assert.equal(a.id, "tt1");
  assert.equal(z.calls.find((c) => c.path === "/api/v1/accounts").query, "", "bez nieudokumentowanych filtrów");
  const none = await mockZernio({ accounts: [{ _id: "ig1", platform: "instagram" }] });
  await assert.rejects(findTikTokAccount({}, makeZernio({ ZERNIO_API_KEY: "sk_test", ZERNIO_BASE: `${none.base}/api/v1` })), /widoczne konta: instagram/);
  none.close();
  z.close();
});

// --- YouTube Shorts przez Zernio -------------------------------------------------------
const YT_ACCOUNTS = [{ _id: "acc_tt", platform: "tiktok", username: "welife.world" }, { _id: "acc_yt", platform: "youtube", displayName: "WE.LIFE" }];
const ytReel = (over = {}) => reel({
  platforms: ["youtube"], ai_imagery: true, cover: "media/a.jpg",
  caption: `Ile razy w tygodniu decydujesz, co na obiad?\n\nLink do darmowej bety WE.LIFE masz w bio @welife.world. ${BETA}\n\nZdjęcia w filmie to ilustracje wygenerowane przez AI.\n\n#planposiłków`,
  ...over,
});

test("YouTube: rolka wychodzi jako Short z tytułem z pierwszej linii, linkiem do strony, miniaturą i oznaczeniem AI", async () => {
  const z = await mockZernio({ accounts: YT_ACCOUNTS });
  const root = fixture([ytReel()]);
  const r = await run(zernioEnv(z), { root, ...quiet });
  assert.equal(r.failures, 0);
  const post = z.calls.find((c) => c.path === "/api/v1/posts");
  assert.deepEqual(post.json.platforms, [{
    platform: "youtube", accountId: "acc_yt",
    platformSpecificData: { title: "Ile razy w tygodniu decydujesz, co na obiad?", visibility: "public", madeForKids: false, containsSyntheticMedia: true, categoryId: "26" },
  }]);
  assert.deepEqual(post.json.mediaItems, [{ type: "video", url: `${z.base}/files/media/R1.mp4`, thumbnail: `${z.base}/files/media/a.jpg` }]);
  assert.match(post.json.content, /masz na welife\.world\./);
  assert.doesNotMatch(post.json.content, /w bio/);
  assert.match(post.json.content, /https:\/\/welife\.world\/\?utm_source=youtube&utm_medium=social&utm_campaign=r1$/);
  assert.equal(post.json.tiktokSettings, undefined);
  const s = state(root)["r1:youtube"];
  assert.deepEqual([s.status, s.via, s.permalink], ["published", "zernio", "https://www.youtube.com/watch?v=abc123"]);
  const before = z.calls.length;
  await run(zernioEnv(z), { root, ...quiet });
  assert.equal(z.calls.length, before, "drugi przebieg nie publikuje ponownie");
  z.close();
});

test("YouTube: bez podłączonego kanału rolka czeka bez błędu i bez zużywania prób, a TikTok wychodzi normalnie", async () => {
  const z = await mockZernio();
  const root = fixture([ytReel({ platforms: ["tiktok", "youtube"] })]);
  const logs = [];
  const r = await run(zernioEnv(z), { root, log: (l) => logs.push(l) });
  assert.equal(r.failures, 0);
  const s = state(root);
  assert.equal(s["r1:tiktok"].status, "published");
  assert.equal(s["r1:youtube"], undefined);
  assert.equal(z.calls.filter((c) => c.path === "/api/v1/posts").length, 1);
  assert.ok(logs.some((l) => /POMINIĘTE r1:youtube: w Zernio nie ma podłączonego kanału YouTube/.test(l)));
  // bez klucza Zernio też tylko pominięcie
  const root2 = fixture([ytReel()]);
  const g = await mockGraph();
  const r2 = await run(env(g), { root: root2, ...quiet });
  assert.equal(r2.failures, 0);
  assert.equal(existsSync(join(root2, "state", "published.json")), false, "nic nie zapisano w stanie");
  assert.equal(g.calls.length, 0);
  g.close();
  z.close();
});

test("YouTube: odrzuca karuzelę i za długi tytuł; długą pierwszą linię przycina do 100 znaków", async () => {
  const { validate, youtubeTitle } = await import("../scripts/lib.mjs");
  assert.match(validate(ytReel({ type: "carousel", media: ["media/a.jpg", "media/b.jpg"] }), "youtube").join(), /tylko rolki/);
  assert.match(validate(ytReel({ youtube: { title: "x".repeat(101) } }), "youtube").join(), /limit to 100/);
  assert.deepEqual(validate(ytReel(), "youtube"), []);
  const long = youtubeTitle({ caption: `${"słowo ".repeat(30)}\n\nreszta` });
  assert.ok(long.length <= 100 && long.endsWith("…") && !long.includes("  "), long);
  assert.equal(youtubeTitle({ caption: "Krótki tytuł?\n\nopis", youtube: {} }), "Krótki tytuł?");
});
