// K4 PL IG (2026-11-10): media_publish trzy razy zwrócił "(#4) Application request limit reached",
// a Instagram i tak opublikował post za każdym razem (3 widoczne kopie przy statusie failed).
// Atrapa Graph API ze stanem (kontenery + posty konta) odtwarza to bez żadnego zapisu na platformie.
// Testy: uzgadnianie przed ponowieniem, ten sam kontener, odstęp po limicie, wąskie requeue/reconcile,
// okno 24 h i diagnostyka tylko do odczytu w check-config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, rateLimitedUntil, isRateLimited, findUnresolved } from "../scripts/publish.mjs";
import { requeue } from "../scripts/requeue.mjs";
import { reconcile } from "../scripts/reconcile.mjs";
import { check } from "../scripts/check-config.mjs";
import { loadQueue, findInstagramByCaption } from "../scripts/lib.mjs";
import { backoffMinutes, regainMinutes } from "../scripts/publish.mjs";

const CAPTION = "Zapisz ten post na niedzielę.\n\nPlan w 4 krokach. To wersja beta (testowa).";
const MIN = 60 * 1000;
const T0 = Date.parse("2026-11-10T15:42:00Z");
const iso = (ms) => new Date(ms).toISOString();
const metaTime = (ms) => iso(ms).replace(/\.\d+Z$/, "+0000");

// mode przy media_publish: ok | limit (błąd, nic nie wychodzi) | ambiguous (post wychodzi I błąd kod 4) | code2
//   | lost (post wychodzi, a połączenie zrywa się przed odpowiedzią: zgubione potwierdzenie)
async function mockGraph() {
  const calls = [];
  const flags = { mode: "ok", clock: T0, failGetContainer: false, noStatus: false, paging: false, onPublish: null };
  const containers = new Map(); // id → { status, caption }
  const media = []; // posty konta, najnowsze pierwsze
  let n = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const params = Object.fromEntries(req.method === "GET" ? url.searchParams : new URLSearchParams(body));
    calls.push({ method: req.method, path: url.pathname, params });
    const send = (code, obj, headers = {}) => (res.writeHead(code, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(obj)));
    if (url.pathname.startsWith("/files/")) return res.writeHead(206).end("x");
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    if (p === "IG/media" && req.method === "GET") return send(200, { data: media, ...(flags.paging ? { paging: { next: "https://graph/next" } } : {}) });
    if (p === "IG/media") {
      const id = `c${++n}`;
      containers.set(id, { status: "FINISHED", caption: params.caption });
      return send(200, { id });
    }
    if (p === "IG/media_publish") {
      const c = containers.get(params.creation_id);
      if (!c || c.status !== "FINISHED") return send(400, { error: { message: "container not publishable", code: 9007 } });
      flags.onPublish?.();
      if (flags.mode === "limit") return send(403, { error: { message: "(#4) Application request limit reached", code: 4 } });
      if (flags.mode === "code2") return send(400, { error: { message: "Temporary error", code: 2 } });
      c.status = "PUBLISHED";
      const id = `${17950000000000000 + ++n}`;
      media.unshift({ id, caption: c.caption, timestamp: metaTime(flags.clock), permalink: `https://www.instagram.com/p/P${id.slice(-4)}/` });
      if (flags.mode === "ambiguous") return send(403, { error: { message: "(#4) Application request limit reached", code: 4 } });
      if (flags.mode === "lost") return res.destroy();
      return send(200, { id });
    }
    if (/^c\d+$/.test(p)) {
      if (flags.failGetContainer) return send(500, { error: { message: "Service temporarily unavailable", code: 2 } });
      if (flags.noStatus) return send(200, { id: p });
      return send(200, { status_code: containers.get(p)?.status ?? "EXPIRED" });
    }
    if (/^\d{17}$/.test(p)) return send(200, { permalink: media.find((m) => m.id === p)?.permalink });
    if (p === "IG/content_publishing_limit") {
      return send(200, { data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] }, {
        "x-app-usage": JSON.stringify({ call_count: 12, total_time: 3, total_cputime: 2 }),
        "x-business-use-case-usage": JSON.stringify({ "17841453915108697": [{ type: "instagram", call_count: 7, total_cputime: 1, total_time: 2, estimated_time_to_regain_access: 0 }] }),
      });
    }
    if (p === "debug_token") return send(200, { data: { is_valid: true, expires_at: 0, scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "pages_manage_posts"] } });
    if (p === "PAGE" && params.fields === "access_token") return send(200, { access_token: "PAGE_TOKEN" });
    if (p === "PAGE") return send(200, { name: "WE.LIFE", instagram_business_account: { id: "IG", username: "welife.world" } });
    if (p === "IG") return send(200, { username: "welife.world", biography: "beta", website: "https://welife.world/" });
    if (p.startsWith("PAGE/")) return send(200, { id: `fb${++n}` });
    send(404, { error: { message: `unknown ${p}` } });
  });
  await new Promise((r) => server.listen(0, r));
  const graphCalls = () => calls.filter((c) => !c.path.startsWith("/files/"));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, graphCalls, flags, containers, media, close: () => server.close() };
}

const k4 = (over = {}) => ({
  id: "2026-11-10-0830-k4", publish_at: "2026-11-10T08:30:00+01:00", platforms: ["instagram", "facebook"],
  type: "carousel", media: ["media/a.jpg", "media/b.jpg"], caption: CAPTION, ...over,
});
const KEY = "2026-11-10-0830-k4:instagram";

function fixture(posts, state = {}) {
  const root = mkdtempSync(join(tmpdir(), "social-rl-"));
  for (const d of ["queue", "state", "media"]) mkdirSync(join(root, d));
  for (const f of ["a.jpg", "b.jpg"]) writeFileSync(join(root, "media", f), "x");
  for (const p of posts) writeFileSync(join(root, "queue", `${p.id}.json`), JSON.stringify(p));
  writeFileSync(join(root, "state", "published.json"), JSON.stringify(state, null, 2) + "\n");
  return root;
}
const stateText = (root) => readFileSync(join(root, "state", "published.json"), "utf8");
const readState = (root) => JSON.parse(stateText(root));
const env = (g, now, over = {}) => ({ PUBLISH_LIVE: "true", META_ACCESS_TOKEN: "SECRET_TOKEN", IG_USER_ID: "IG", FB_PAGE_ID: "PAGE", GRAPH_BASE: g.base, MEDIA_BASE_URL: `${g.base}/files/`, NOW: iso(now), ...over });
const quiet = { log: () => {}, waitOpts: { intervalMs: 1 } };
const at = async (g, root, now, over = {}, opts = quiet) => ((g.flags.clock = now), run(env(g, now, over), { root, ...opts }));
const count = (g, path, method = "POST") => g.calls.filter((c) => c.method === method && c.path.endsWith(path)).length;
const OLD_CADENCE = { RATE_LIMIT_BACKOFF_MINUTES: "0" }; // ponowienie co przebieg, jak 15:42/15:47/15:56

// Kształt rzeczywistego wpisu z state/published.json (main@261cf83), bez zmian treści.
const realK4State = () => ({
  "2026-11-10-0830-k4:facebook": { attempts: 1, status: "published", id: "1306038305932559_122124763251483309", published_at: "2026-11-10T15:43:21.589Z", updated_at: "2026-11-10T15:42:17.734Z" },
  [KEY]: {
    attempts: 3, status: "failed", error: "Graph API POST 17841453915108697/media_publish: Application request limit reached",
    history: ["15:42:17.734", "15:47:20.710", "15:56:19.820"].map((t) => ({ at: `2026-11-10T${t}Z`, stage: "publish", error: "Graph API POST 17841453915108697/media_publish: Application request limit reached" })),
    updated_at: "2026-11-10T15:56:19.820Z",
  },
  "2026-11-10-2100-r19-en:instagram": { attempts: 1, status: "published", id: "18205273270331643", permalink: "https://www.instagram.com/reel/DfkvTssDXhU/" },
});

// ── Odtworzenie K4 i uzgadnianie ────────────────────────────────────────────
test("K4 odtworzenie: media_publish publikuje i zwraca kod 4 → następny przebieg UZGADNIA, 1 post zamiast 3, bez nowych kontenerów", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "ambiguous";
  await at(g, root, T0, OLD_CADENCE);
  let e = readState(root)[KEY];
  assert.equal(e.status, "retry");
  assert.deepEqual(e.history.map((h) => [h.stage, h.code]), [["publish", 4]]);
  assert.match(e.creation_id, /^c\d+$/, "kontener z niejednoznacznej próby zapisany");
  assert.equal(e.creation_at, iso(T0));
  const containersAfterFirst = count(g, "/IG/media");

  for (const m of [5, 14]) await at(g, root, T0 + m * MIN, OLD_CADENCE);
  e = readState(root)[KEY];
  assert.equal(e.status, "published");
  assert.equal(e.id, g.media[0].id);
  assert.equal(e.permalink, g.media[0].permalink);
  assert.equal(e.reconciled_container_status, "PUBLISHED");
  assert.equal(g.media.length, 1, "na koncie jest dokładnie jeden post (przed zmianą: 3)");
  assert.equal(count(g, "/IG/media_publish"), 1, "media_publish wywołany raz");
  assert.equal(count(g, "/IG/media"), containersAfterFirst, "uzgadnianie nie tworzy kontenerów");
  assert.doesNotMatch(stateText(root), /SECRET_TOKEN/);
  g.close();
});

test("limit bez publikacji (kontener FINISHED): po 60 min ten sam kontener, zero nowych POST /media, jedna publikacja", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "limit";
  await at(g, root, T0);
  const creation = readState(root)[KEY].creation_id;
  const before = g.graphCalls().length;
  const logs = [];
  for (const m of [10, 20, 59]) await at(g, root, T0 + m * MIN, {}, { log: (l) => logs.push(l), waitOpts: { intervalMs: 1 } });
  assert.equal(g.graphCalls().length, before, "w oknie limitu zero wywołań Graph");
  assert.equal(readState(root)[KEY].attempts, 1, "czekanie nie zużywa prób");
  assert.ok(logs.some((l) => l.startsWith(`CZEKAM ${KEY}`)));

  g.flags.mode = "ok";
  const posts = count(g, "/IG/media");
  await at(g, root, T0 + 61 * MIN);
  const e = readState(root)[KEY];
  assert.equal(e.status, "published");
  assert.equal(e.reconciled_at, undefined, "to zwykła publikacja, nie uzgodnienie");
  assert.equal(count(g, "/IG/media"), posts, "brak nowych kontenerów");
  assert.deepEqual(g.calls.filter((c) => c.path.endsWith("/IG/media_publish")).map((c) => c.params.creation_id), [creation, creation]);
  assert.equal(g.media.length, 1);
  await at(g, root, T0 + 120 * MIN);
  assert.equal(count(g, "/IG/media_publish"), 2, "kolejny przebieg nie dubluje");
  g.close();
});

test("kontener EXPIRED i brak posta na koncie: nowy kontener i jedna publikacja", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "code2";
  await at(g, root, T0);
  const old = readState(root)[KEY].creation_id;
  g.containers.get(old).status = "EXPIRED";
  g.flags.mode = "ok";
  await at(g, root, T0 + 10 * MIN);
  const e = readState(root)[KEY];
  assert.equal(e.status, "published");
  assert.notEqual(g.calls.filter((c) => c.path.endsWith("/IG/media_publish")).at(-1).params.creation_id, old);
  assert.equal(g.media.length, 1);
  g.close();
});

test("kontener PUBLISHED, a posta nie widać na koncie: failed od razu (do sprawdzenia), bez media_publish", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "code2";
  await at(g, root, T0);
  g.containers.get(readState(root)[KEY].creation_id).status = "PUBLISHED";
  await at(g, root, T0 + 10 * MIN);
  const e = readState(root)[KEY];
  assert.equal(e.status, "failed");
  assert.equal(e.attempts, 2);
  assert.match(e.error, /PUBLISHED, a posta nie ma na koncie/);
  assert.equal(count(g, "/IG/media_publish"), 1, "tylko pierwotna próba");
  g.close();
});

test("błąd odczytu podczas uzgadniania: retry, bez media_publish, kontener zachowany", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "code2";
  await at(g, root, T0);
  const creation = readState(root)[KEY].creation_id;
  g.flags.failGetContainer = true;
  await at(g, root, T0 + 10 * MIN);
  const e = readState(root)[KEY];
  assert.equal(e.status, "retry");
  assert.equal(e.creation_id, creation);
  assert.equal(e.creation_at, iso(T0), "czas pierwszego kontenera bez zmian");
  assert.equal(count(g, "/IG/media_publish"), 1);
  g.close();
});

test("[REGRESJA] błąd kod 2 jest ponawiany w następnym przebiegu (teraz tym samym kontenerem)", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "code2";
  await at(g, root, T0);
  await at(g, root, T0 + 10 * MIN);
  assert.equal(count(g, "/IG/media_publish"), 2);
  assert.equal(readState(root)[KEY].attempts, 2);
  g.close();
});

test("rozpoznanie limitu: kody Meta i starsze wpisy bez kodu; failed i wpis po requeue nie czekają", () => {
  const legacy = realK4State()[KEY];
  for (const code of [4, 17, 32, 613, 80002]) assert.equal(isRateLimited({ code }), true, String(code));
  assert.equal(isRateLimited({ code: 2, error: "Temporary error" }), false);
  assert.equal(isRateLimited(legacy.history[0]), true, "tekst bez kodu");
  assert.equal(rateLimitedUntil({ ...legacy, status: "retry" }, 60 * MIN), Date.parse("2026-11-10T16:56:19.820Z"));
  assert.equal(rateLimitedUntil(legacy, 60 * MIN), 0, "failed obsługuje requeue/reconcile, nie publikator");
  assert.equal(rateLimitedUntil({ attempts: 0, requeued_from: { history: legacy.history } }, 60 * MIN), 0);
});

// ── requeue / reconcile ─────────────────────────────────────────────────────
test("requeue przenosi kontener: pierwsza próba po requeue najpierw uzgadnia i nie publikuje drugi raz", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.flags.mode = "ambiguous";
  for (const m of [0, 10, 20]) await at(g, root, T0 + m * MIN, { MAX_ATTEMPTS: "1" });
  assert.equal(readState(root)[KEY].status, "failed");
  const { sha256 } = requeue([KEY], { root, log: () => {} });
  requeue([KEY], { root, apply: true, expectSha256: sha256, verifiedAbsent: "test: operator nie sprawdził dokładnie", log: () => {} });
  assert.match(readState(root)[KEY].creation_id, /^c\d+$/);
  g.flags.mode = "ok";
  await at(g, root, T0 + 30 * MIN);
  assert.equal(readState(root)[KEY].status, "published");
  assert.equal(g.media.length, 1, "nawet zbyt pobieżne potwierdzenie operatora nie daje duplikatu");
  g.close();
});

test("K4 bez kontenera w stanie (dzisiejszy wpis): requeue tylko IG → jedna publikacja IG, zero wywołań FB, inne wpisy bez zmian", async () => {
  const g = await mockGraph();
  const root = fixture([k4()], realK4State());
  assert.throws(() => requeue(["2026-11-10-0830-k4:facebook"], { root, log: () => {} }), /tylko "failed"/, "FB nie da się wznowić");
  const { sha256 } = requeue([KEY], { root, log: () => {} });
  assert.throws(() => requeue([KEY], { root, apply: true, expectSha256: sha256, log: () => {} }), /brak dowodu/);
  requeue([KEY], { root, apply: true, expectSha256: sha256, verifiedAbsent: "Operator test: IG bez PL K4", now: Date.parse("2026-11-11T06:00:00Z"), log: () => {} });
  const before = readState(root);
  await at(g, root, Date.parse("2026-11-11T06:05:00Z"));
  const after = readState(root);
  assert.equal(after[KEY].status, "published");
  assert.equal(after[KEY].requeued_from.history.length, 3);
  assert.equal(count(g, "/IG/media_publish"), 1);
  assert.equal(g.calls.filter((c) => c.path.includes("/PAGE")).length, 0, "zero wywołań strony FB");
  for (const k of ["2026-11-10-0830-k4:facebook", "2026-11-10-2100-r19-en:instagram"]) assert.deepEqual(after[k], before[k], k);
  g.close();
});

test("K4: wznowienie po 24 h od terminu bez force → skipped_stale bez wywołań; z force → tylko IG", async () => {
  const g = await mockGraph();
  const late = Date.parse("2026-11-11T07:31:00Z"); // termin 07:30Z + 24 h
  for (const force of [false, true]) {
    const root = fixture([k4(force ? { force: true } : {})], realK4State());
    const { sha256 } = requeue([KEY], { root, log: () => {} });
    requeue([KEY], { root, apply: true, expectSha256: sha256, verifiedAbsent: "Operator test: IG bez PL K4", log: () => {} });
    await at(g, root, late);
    assert.equal(readState(root)[KEY].status, force ? "published" : "skipped_stale");
    assert.equal(readState(root)["2026-11-10-0830-k4:facebook"].id, "1306038305932559_122124763251483309");
  }
  assert.equal(count(g, "/IG/media_publish"), 1);
  assert.equal(g.calls.filter((c) => c.path.includes("/PAGE")).length, 0);
  g.close();
});

test("reconcile: próba bez zapisu; apply wymaga skrótu i dowodu; zapisuje id i kopie; nic poza tym kluczem; potem cisza", async () => {
  const root = fixture([k4()], realK4State());
  const before = stateText(root);
  const opts = { id: "18145478602526111", duplicates: ["18213366043365269", "18458132017192894=https://www.instagram.com/p/DfkR5dOjbon/"], log: () => {} };
  const { sha256 } = reconcile(KEY, { root, ...opts });
  assert.equal(stateText(root), before);
  assert.throws(() => reconcile(KEY, { root, ...opts, apply: true, observed: "Operator MBS 21:38Z" }), /expect-sha256/);
  assert.throws(() => reconcile(KEY, { root, ...opts, apply: true, expectSha256: sha256 }), /observed-on-platform/);
  assert.throws(() => reconcile(KEY, { root, ...opts, apply: true, expectSha256: "0".repeat(64), observed: "Operator MBS 21:38Z" }), /zmienił się/);
  assert.throws(() => reconcile(KEY, { root, ...opts, id: "abc" }), /--id/);
  assert.throws(() => reconcile(KEY, { root, ...opts, duplicates: ["18145478602526111"] }), /tego samego id/);
  assert.throws(() => reconcile("2026-11-10-0830-k4:facebook", { root, ...opts }), /uzgadniam tylko/);
  assert.equal(stateText(root), before, "odmowy nie zmieniają stanu");

  reconcile(KEY, { root, ...opts, apply: true, expectSha256: sha256, observed: "Operator 2026-11-10 21:38Z MBS + profil IG: 3 kopie PL K4", now: Date.parse("2026-11-11T08:00:00Z") });
  const s = readState(root);
  const orig = realK4State();
  assert.equal(s[KEY].status, "published");
  assert.equal(s[KEY].id, "18145478602526111");
  assert.equal(s[KEY].error, undefined);
  assert.equal(s[KEY].reconciled_from.status, "failed");
  assert.equal(s[KEY].history.length, 3, "historia prób zachowana");
  assert.deepEqual(s[KEY].duplicates_on_platform, [{ id: "18213366043365269" }, { id: "18458132017192894", permalink: "https://www.instagram.com/p/DfkR5dOjbon/" }]);
  for (const k of ["2026-11-10-0830-k4:facebook", "2026-11-10-2100-r19-en:instagram"]) assert.deepEqual(s[k], orig[k], k);
  assert.throws(() => reconcile(KEY, { root, ...opts }), /uzgadniam tylko/, "drugi raz odmawia");
  assert.throws(() => requeue([KEY], { root, log: () => {} }), /tylko "failed"/, "requeue nie ruszy uzgodnionego wpisu");
  assert.deepEqual(findUnresolved(s, loadQueue(join(root, "queue")), Date.parse("2026-11-11T08:00:00Z"), 48 * 60 * MIN), [], "alarm znika");

  const g = await mockGraph();
  await at(g, root, Date.parse("2026-11-11T08:10:00Z"));
  assert.equal(g.graphCalls().length, 0, "publikator nic nie wysyła");
  g.close();
});

// ── check-config (tylko odczyt) ─────────────────────────────────────────────
test("check-config: limit i zużycie bez id kont; kopie z tym samym opisem; failed IG obecny na koncie = problem", async () => {
  const g = await mockGraph();
  const root = fixture([k4()], realK4State());
  const envC = { META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base };
  const logs = [];
  g.media.push({ id: "17954535237334135", caption: "Save this post for Sunday. beta", timestamp: "2026-11-10T09:16:04+0000" });
  const absent = await check(envC, { log: (l) => logs.push(l), root });
  assert.deepEqual(absent.problems, []);
  assert.ok(logs.some((l) => /IG limit publikacji: 3\/100 w 24 h/.test(l)));
  assert.ok(logs.some((l) => l.startsWith(`${KEY} (failed): brak na koncie od 2026-11-10T07:30:00.000Z (rozstrzygające`)), "granica = termin posta, gdy brak kontenera");
  const usage = logs.find((l) => l.startsWith("zużycie limitów Meta"));
  assert.match(usage, /call_count":12/);
  assert.match(usage, /max call_count 7%/);
  assert.doesNotMatch(usage, /17841453915108697/, "bez identyfikatorów kont w publicznym logu");
  assert.ok(g.calls.every((c) => c.method === "GET"), "diagnostyka tylko czyta");

  const logs2 = [];
  for (const [id, t] of [["18145478602526111", "15:43:10"], ["18213366043365269", "15:48:12"], ["18458132017192894", "15:57:05"]]) {
    g.media.unshift({ id, caption: CAPTION, timestamp: `2026-11-10T${t}+0000`, permalink: id.endsWith("894") ? "https://www.instagram.com/p/DfkR5dOjbon/" : undefined });
  }
  const present = await check(envC, { log: (l) => logs2.push(l), root });
  assert.match(present.problems.join(" "), /JEST na Instagramie .*ryzyko duplikatu/);
  assert.ok(logs2.some((l) => /^UWAGA: 3 posty IG z identycznym opisem: 18458132017192894 https:\/\/www\.instagram\.com\/p\/DfkR5dOjbon\//.test(l)));
  assert.ok(g.calls.every((c) => c.method === "GET"));
  g.close();
});

// ── Fail-closed: wyszukiwanie po opisie (przegląd operatora, pkt 1) ─────────
const fakeGraph = (page) => ({ get: async () => page });
const SINCE = Date.parse("2026-11-10T15:42:00Z");
const item = (over = {}) => ({ id: "18145478602526111", caption: CAPTION, timestamp: "2026-11-10T15:43:10+0000", permalink: "https://www.instagram.com/p/X/", ...over });

test("wyszukiwanie: zła lub brakująca dolna granica, pasujący post bez czasu lub bez id → inconclusive, nigdy found/absent", async () => {
  for (const since of [undefined, NaN, 0, -1, Date.parse("nie-data")]) {
    assert.equal((await findInstagramByCaption(fakeGraph({ data: [item()] }), "IG", CAPTION, since)).status, "inconclusive", String(since));
  }
  for (const bad of [item({ timestamp: undefined }), item({ timestamp: "wczoraj" }), item({ id: undefined }), item({ id: "" })]) {
    const r = await findInstagramByCaption(fakeGraph({ data: [bad, item({ caption: "inny", timestamp: "2026-11-01T10:00:00+0000" })] }), "IG", CAPTION, SINCE);
    assert.equal(r.status, "inconclusive", JSON.stringify(bad));
  }
  assert.equal((await findInstagramByCaption(fakeGraph({}), "IG", CAPTION, SINCE)).status, "inconclusive", "odpowiedź bez listy");
});

test("wyszukiwanie: pełna strona bez dojścia do granicy (paginacja) → inconclusive; lista sięgająca przed granicę albo całe konto → absent", async () => {
  const newer = Array.from({ length: 50 }, (_, i) => item({ id: `9${i}`, caption: `inny ${i}`, timestamp: "2026-11-10T20:00:00+0000" }));
  assert.equal((await findInstagramByCaption(fakeGraph({ data: newer, paging: { next: "x" } }), "IG", CAPTION, SINCE)).status, "inconclusive");
  const reaches = [...newer.slice(0, 3), item({ id: "1", caption: "stary", timestamp: "2026-11-01T10:00:00+0000" })];
  assert.equal((await findInstagramByCaption(fakeGraph({ data: reaches, paging: { next: "x" } }), "IG", CAPTION, SINCE)).status, "absent");
  assert.equal((await findInstagramByCaption(fakeGraph({ data: [] }), "IG", CAPTION, SINCE)).status, "absent", "konto bez postów, bez kolejnej strony");
});

test("wyszukiwanie: ten sam opis dni wcześniej to nie dopasowanie; kilka kopii po granicy → found z najstarszą i listą kopii", async () => {
  const old = item({ id: "100", timestamp: "2026-11-03T08:30:00+0000" });
  assert.equal((await findInstagramByCaption(fakeGraph({ data: [old] }), "IG", CAPTION, SINCE)).status, "absent", "legalny powtórzony opis z innego dnia");
  const copies = [item({ id: "3", timestamp: "2026-11-10T15:57:05+0000" }), item({ id: "2", timestamp: "2026-11-10T15:48:12+0000" }), item({ id: "1", timestamp: "2026-11-10T15:43:10+0000" }), old];
  const r = await findInstagramByCaption(fakeGraph({ data: copies }), "IG", CAPTION, SINCE);
  assert.equal(r.status, "found");
  assert.equal(r.id, "1");
  assert.deepEqual(r.copies, ["1", "2", "3"]);
});

// ── Fail-closed: stan kontenera (pkt 2) ──────────────────────────────────────
for (const [label, prep, expectStatus] of [
  ["IN_PROGRESS → retry (czekamy), bez POST", (g, c) => { g.containers.get(c).status = "IN_PROGRESS"; }, "retry"],
  ["ERROR → sprawdzenie ręczne, bez POST", (g, c) => { g.containers.get(c).status = "ERROR"; }, "failed"],
  ["nieznany status → sprawdzenie ręczne, bez POST", (g, c) => { g.containers.get(c).status = "SOMETHING_NEW"; }, "failed"],
  ["brak statusu w odpowiedzi → sprawdzenie ręczne, bez POST", (g) => { g.flags.noStatus = true; }, "failed"],
  ["FINISHED, ale lista niepełna (paginacja) → sprawdzenie ręczne, bez POST", (g) => { g.flags.paging = true; for (let i = 0; i < 50; i++) g.media.push({ id: `5${i}`, caption: `inny ${i}`, timestamp: "2026-11-10T16:00:00+0000" }); }, "failed"],
]) {
  test(`kontener: ${label}`, async () => {
    const g = await mockGraph();
    const root = fixture([k4({ platforms: ["instagram"] })]);
    g.flags.mode = "code2";
    await at(g, root, T0);
    const creation = readState(root)[KEY].creation_id;
    prep(g, creation);
    g.flags.mode = "ok";
    const posts = count(g, "/IG/media");
    await at(g, root, T0 + 10 * MIN);
    const e = readState(root)[KEY];
    assert.equal(e.status, expectStatus);
    assert.equal(e.creation_id, creation, "kontener zachowany");
    assert.equal(count(g, "/IG/media_publish"), 1, "żadnego kolejnego media_publish");
    assert.equal(count(g, "/IG/media"), posts, "żadnego nowego kontenera");
    g.close();
  });
}

// ── Trwały zapis kontrolny i zgubione potwierdzenie (pkt 3) ──────────────────
test("kontener jest na dysku ZANIM wyjdzie media_publish; zgubiona odpowiedź → restart uzgadnia, bez drugiego POST", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  let onDisk = null;
  g.flags.onPublish = () => { onDisk = readState(root)[KEY]; };
  g.flags.mode = "lost";
  await at(g, root, T0);
  assert.match(onDisk?.creation_id ?? "", /^c\d+$/, "zapis kontrolny przed media_publish");
  assert.equal(onDisk.status, undefined, "zapis kontrolny nie udaje statusu");
  assert.equal(readState(root)[KEY].status, "retry");
  assert.equal(g.media.length, 1, "post wyszedł mimo zerwanej odpowiedzi");
  g.flags.onPublish = null;
  g.flags.mode = "ok";
  await at(g, root, T0 + 10 * MIN); // restart = nowy przebieg czytający stan z dysku
  const e = readState(root)[KEY];
  assert.equal(e.status, "published");
  assert.equal(e.id, g.media[0].id);
  assert.equal(count(g, "/IG/media_publish"), 1, "bez drugiego media_publish");
  assert.equal(g.media.length, 1);
  g.close();
});

test("id posta z zapisu kontrolnego (przebieg przerwany po media_publish) → następny przebieg zapisuje je bez żadnego wywołania API", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })], { [KEY]: { attempts: 0, creation_id: "c9", creation_at: iso(T0), media_id: "17950000000000123", updated_at: iso(T0) } });
  await at(g, root, T0 + 10 * MIN);
  const e = readState(root)[KEY];
  assert.equal(e.status, "published");
  assert.equal(e.id, "17950000000000123");
  assert.equal(e.reconciled_from_checkpoint, true);
  assert.equal(g.graphCalls().length, 0);
  g.close();
});

test("stan poprzedniego przebiegu zgubiony (np. push się nie udał): post z tym opisem jest już od terminu → sprawdzenie ręczne, bez POST", async () => {
  const g = await mockGraph();
  const root = fixture([k4({ platforms: ["instagram"] })]);
  g.media.push({ id: "18145478602526111", caption: CAPTION, timestamp: "2026-11-10T15:43:10+0000", permalink: "https://www.instagram.com/p/DfkQSaIl_5B/" });
  await at(g, root, T0 + 30 * MIN);
  const e = readState(root)[KEY];
  assert.equal(e.status, "failed");
  assert.match(e.error, /już na koncie od terminu/);
  assert.equal(g.calls.filter((c) => c.method === "POST").length, 0, "zero POST-ów");
  g.close();
});

// ── Odstęp po limicie (pkt 4) ───────────────────────────────────────────────
test("odstęp: zła wartość zmiennej → 60 min; 0 = świadomie bez odstępu; szacowany czas Meta wydłuża czekanie; zły czas próby → okno od teraz", () => {
  for (const bad of [undefined, null, "", " ", "abc", "NaN", "-5", "1441", "Infinity"]) assert.equal(backoffMinutes(bad), 60, String(bad));
  assert.equal(backoffMinutes("0"), 0);
  assert.equal(backoffMinutes("90"), 90);
  assert.equal(regainMinutes(JSON.stringify({ "1": [{ estimated_time_to_regain_access: 140 }, { estimated_time_to_regain_access: 5 }] })), 140);
  assert.equal(regainMinutes("{zepsute"), 0);
  const last = { at: "2026-11-10T15:56:19.820Z", stage: "publish", code: 4, error: "limit", regain_minutes: 140 };
  assert.equal(rateLimitedUntil({ status: "retry", history: [last] }, 60 * MIN), Date.parse(last.at) + 140 * MIN);
  const now = Date.parse("2026-11-10T18:00:00Z");
  assert.equal(rateLimitedUntil({ status: "retry", history: [{ ...last, at: "zły", regain_minutes: undefined }] }, 60 * MIN, now), now + 60 * MIN, "fail-closed, nie natychmiast");
});

// ── Diagnostyka tylko Meta (pkt 5) ──────────────────────────────────────────
test("check-config --meta-only: zero wywołań TikToka/Zernio mimo sekretów; niepewny lub nieudany odczyt obecności to problem, nie nieobecność", async () => {
  const g = await mockGraph();
  const root = fixture([k4()], realK4State());
  const outside = [];
  const fetchImpl = (url, init) => { if (!String(url).startsWith(g.base)) outside.push(String(url)); return fetch(url, init); };
  const envC = { META_ACCESS_TOKEN: "T", FB_PAGE_ID: "PAGE", IG_USER_ID: "IG", GRAPH_BASE: g.base, ZERNIO_API_KEY: "sk_x", TIKTOK_CLIENT_KEY: "k", TIKTOK_REFRESH_TOKEN: "r" };
  g.flags.paging = true;
  for (let i = 0; i < 50; i++) g.media.push({ id: `5${i}`, caption: `inny ${i}`, timestamp: "2026-11-10T20:00:00+0000" });
  const r = await check(envC, { log: () => {}, root, metaOnly: true, fetchImpl });
  assert.deepEqual(outside, [], "żadnego ruchu poza atrapą Graph");
  assert.match(r.problems.join(" "), /nie można potwierdzić nieobecności .*to nie jest dowód/);
  assert.ok(g.calls.every((c) => c.method === "GET"));
  g.close();
});
