// Alarm o wyczerpanych próbach, wznowienie pojedynczych pozycji (CAS/blokada/dowód), historia prób
// z etapem i wybór hosta mediów (scenariusz K4: 403 z CDN). Testy oznaczone [REGRESJA] opisują
// zachowanie sprzed zmian i muszą być zielone także na kodzie bazowym.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as publish from "../scripts/publish.mjs";
// Importy odporne na kod bazowy (HEAD nie ma requeue.mjs ani findUnresolved): testy nowych zachowań
// są wtedy czerwone, a [REGRESJA] zielone, zamiast jednego błędu importu dla całego pliku.
const requeueModule = await import("../scripts/requeue.mjs").catch(() => ({}));
const { run } = publish;
const findUnresolved = publish.findUnresolved ?? (() => { throw new Error("brak findUnresolved w kodzie bazowym"); });
const requeue = requeueModule.requeue ?? (() => { throw new Error("brak requeue.mjs w kodzie bazowym"); });

const BETA = "Napisz PLAN. To wersja beta (testowa).";
const NOW = "2026-11-10T09:00:00+01:00";

async function mockServer() {
  const calls = [];
  const flags = { block: [] }; // fragmenty ścieżek zwracające 403
  let n = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const params = Object.fromEntries(req.method === "GET" ? url.searchParams : new URLSearchParams(body));
    calls.push({ method: req.method, path: url.pathname, params });
    const send = (code, obj) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
    if (/^\/(files|raw|cdn)\//.test(url.pathname)) return res.writeHead(flags.block.some((b) => url.pathname.includes(b)) ? 403 : 206).end("x");
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    if (p === "PAGE" && params.fields === "access_token") return send(200, { access_token: "PAGE_TOKEN" });
    if (p === "PAGE/photos" || p === "PAGE/feed") return send(200, { id: `fb${++n}` });
    send(404, { error: { message: `unknown ${p}` } });
  });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, flags, close: () => server.close() };
}

const post = (over = {}) => ({
  id: "k4", publish_at: "2026-11-10T08:30:00+01:00", platforms: ["facebook"], type: "carousel",
  media: ["media/a.jpg", "media/b.jpg"], caption: BETA, ...over,
});

function fixture(posts, state = {}) {
  const root = mkdtempSync(join(tmpdir(), "social-rq-"));
  for (const d of ["queue", "state", "media"]) mkdirSync(join(root, d));
  for (const f of ["a.jpg", "b.jpg"]) writeFileSync(join(root, "media", f), "x");
  for (const p of posts) writeFileSync(join(root, "queue", `${p.id}.json`), JSON.stringify(p));
  writeFileSync(join(root, "state", "published.json"), JSON.stringify(state, null, 2) + "\n");
  return root;
}
const readState = (root) => JSON.parse(readFileSync(join(root, "state", "published.json"), "utf8"));
const env = (g, over = {}) => ({ PUBLISH_LIVE: "true", META_ACCESS_TOKEN: "SECRET_TOKEN", IG_USER_ID: "IG", FB_PAGE_ID: "PAGE", GRAPH_BASE: g.base, MEDIA_BASE_URL: `${g.base}/files/`, NOW, ...over });
const cdnEnv = (g, over = {}) => env(g, { MEDIA_BASE_URL: "", GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc123", RAW_MEDIA_HOST: `${g.base}/raw`, JSDELIVR_MEDIA_HOST: `${g.base}/cdn`, ...over });
const quiet = { log: () => {}, waitOpts: { intervalMs: 1 } };
const failedEntry = (over = {}) => ({ attempts: 3, status: "failed", error: "plik media/b.jpg niedostępny pod publicznym adresem (403)", updated_at: "2026-11-10T07:54:33.282Z", ...over });
const probeHistory = () => [1, 2, 3].map((i) => ({ at: `2026-11-10T07:5${i}:00.000Z`, stage: "probe", error: "plik media/b.jpg niedostępny pod publicznym adresem (403)" }));
const fromTry = (keys, root) => requeue(keys, { root, log: () => {} }).sha256;

// ── Alarm ───────────────────────────────────────────────────────────────────
test("zielony przebieg nie maskuje wyczerpanych prób: nierozwiązana pozycja jest zgłaszana w każdym przebiegu", async () => {
  const g = await mockServer();
  const root = fixture([post()], { "k4:facebook": failedEntry() });
  const logs = [];
  const r = await run(env(g), { root, log: (l) => logs.push(l), waitOpts: { intervalMs: 1 } });
  assert.equal(r.failures, 0);
  assert.deepEqual(r.unresolved.map((u) => u.key), ["k4:facebook"]);
  assert.ok(logs.some((l) => l.startsWith("::error::") && l.includes("k4:facebook")));
  assert.equal(g.calls.length, 0, "failed nadal nie jest ponawiane automatycznie");
  g.close();
});

test("acknowledged, stare (poza oknem), skipped_stale i removed nie alarmują", () => {
  const now = Date.parse(NOW);
  const posts = [post({ id: "a" }), post({ id: "old", publish_at: "2026-11-01T08:30:00+01:00" }), post({ id: "s" }), post({ id: "r" })];
  const state = {
    "a:facebook": failedEntry({ acknowledged: true }), "old:facebook": failedEntry(),
    "s:facebook": { status: "skipped_stale" }, "r:facebook": { status: "removed", id: "x" }, "bezposta:facebook": failedEntry(),
  };
  assert.deepEqual(findUnresolved(state, posts, now, 48 * 3600 * 1000), []);
});

// ── [REGRESJA] zachowania sprzed zmian ──────────────────────────────────────
test("[REGRESJA] opublikowane nie jest publikowane ponownie, a drugi przebieg nie wywołuje API", async () => {
  const g = await mockServer();
  const root = fixture([post()]);
  await run(env(g), { root, ...quiet });
  assert.equal(readState(root)["k4:facebook"].status, "published");
  const before = g.calls.length;
  await run(env(g), { root, ...quiet });
  assert.equal(g.calls.length, before);
  g.close();
});

test("[REGRESJA] jawny MEDIA_BASE_URL jest jedynym hostem; 403 blokuje publikację bez wywołań Graph", async () => {
  const g = await mockServer();
  g.flags.block = ["/files/"];
  const root = fixture([post()]);
  await run(env(g), { root, ...quiet });
  assert.equal(readState(root)["k4:facebook"].status, "retry");
  assert.match(readState(root)["k4:facebook"].error, /niedostępny/);
  assert.equal(g.calls.filter((c) => c.path.includes("/PAGE")).length, 0);
  assert.ok(!g.calls.some((c) => c.path.startsWith("/raw/") || c.path.startsWith("/cdn/")), "żadnych hostów zastępczych przy jawnym adresie");
  g.close();
});

test("[REGRESJA] status failed, skipped_stale i removed nie są ponawiane przez publikator", async () => {
  const g = await mockServer();
  const root = fixture([post({ id: "f" }), post({ id: "s" }), post({ id: "r" })], {
    "f:facebook": failedEntry(), "s:facebook": { status: "skipped_stale" }, "r:facebook": { status: "removed", id: "1" },
  });
  await run(env(g), { root, ...quiet });
  assert.equal(g.calls.length, 0);
  g.close();
});

// ── Host mediów (K4: jsDelivr 403 "Package size exceeded 50 MB") ────────────
test("domyślny host: zdjęcia najpierw z raw; gdy raw zwraca 403, zapasowy jsDelivr", async () => {
  const g = await mockServer();
  const root = fixture([post()]);
  await run(cdnEnv(g), { root, ...quiet });
  assert.equal(readState(root)["k4:facebook"].status, "published");
  assert.ok(g.calls.some((c) => c.path === "/raw/o/r/abc123/media/a.jpg"));
  assert.ok(!g.calls.some((c) => c.path.startsWith("/cdn/")), "jsDelivr nie jest potrzebny, gdy raw działa");
  const photo = g.calls.find((c) => c.path.endsWith("/PAGE/photos"));
  assert.ok(photo.params.url.startsWith(`${g.base}/raw/o/r/abc123/`));
  g.close();

  const g2 = await mockServer();
  g2.flags.block = ["/raw/"];
  const root2 = fixture([post()]);
  await run(cdnEnv(g2), { root: root2, ...quiet });
  assert.equal(readState(root2)["k4:facebook"].status, "published");
  assert.ok(g2.calls.find((c) => c.path.endsWith("/PAGE/photos")).params.url.startsWith(`${g2.base}/cdn/gh/o/r@abc123/`));
  g2.close();
});

test("host jest wybierany dla CAŁEGO posta: jeden plik 403 na pierwszym hoście przełącza wszystkie pliki", async () => {
  const g = await mockServer();
  g.flags.block = ["/raw/o/r/abc123/media/b.jpg"];
  const root = fixture([post()]);
  await run(cdnEnv(g), { root, ...quiet });
  const urls = g.calls.filter((c) => c.path.endsWith("/PAGE/photos")).map((c) => c.params.url);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith(`${g.base}/cdn/`)), "oba zdjęcia z tego samego hosta");
  g.close();
});

test("oba hosty 403: błąd etapu probe, zero wywołań Graph, historia próby zapisana", async () => {
  const g = await mockServer();
  g.flags.block = ["/raw/", "/cdn/"];
  const root = fixture([post()]);
  await run(cdnEnv(g), { root, ...quiet });
  const e = readState(root)["k4:facebook"];
  assert.equal(e.status, "retry");
  assert.deepEqual(e.history.map((h) => h.stage), ["probe"]);
  assert.equal(g.calls.filter((c) => c.path.includes("/PAGE")).length, 0);
  g.close();
});

test("historia prób zapisuje etap: błąd po rozpoczęciu publikacji to stage publish", async () => {
  const g = await mockServer();
  const root = fixture([post({ platforms: ["instagram"], type: "image", media: ["media/a.jpg"] })]);
  await run(env(g), { root, ...quiet }); // atrapa nie ma IG/media → 404 z Graph
  const e = readState(root)["k4:instagram"];
  assert.equal(e.history[0].stage, "publish");
  assert.doesNotMatch(JSON.stringify(e), /SECRET_TOKEN/);
  g.close();
});

// ── requeue: CAS, blokada, dowód ────────────────────────────────────────────
test("requeue: próba niczego nie zmienia i podaje skrót; apply wymaga zgodnego skrótu", () => {
  const root = fixture([post()], { "k4:facebook": failedEntry({ history: probeHistory() }) });
  const before = readFileSync(join(root, "state", "published.json"), "utf8");
  const sha = fromTry(["k4:facebook"], root);
  assert.equal(readFileSync(join(root, "state", "published.json"), "utf8"), before);
  assert.throws(() => requeue(["k4:facebook"], { root, apply: true, log: () => {} }), /expect-sha256/);
  assert.throws(() => requeue(["k4:facebook"], { root, apply: true, expectSha256: "0".repeat(64), log: () => {} }), /stan zmienił się od próby/);
  assert.equal(readFileSync(join(root, "state", "published.json"), "utf8"), before, "odmowa nie zostawia zmian");
  requeue(["k4:facebook"], { root, apply: true, expectSha256: sha, now: Date.parse(NOW), log: () => {} });
  const s = readState(root)["k4:facebook"];
  assert.equal(s.status, undefined);
  assert.equal(s.attempts, 0);
  assert.equal(s.requeue_basis, "history_all_probe");
});

test("requeue: równoległa zmiana stanu po próbie (inny proces/publikator) unieważnia skrót", () => {
  const root = fixture([post()], { "k4:facebook": failedEntry({ history: probeHistory() }), "inny:facebook": { status: "published", id: "7" } });
  const sha = fromTry(["k4:facebook"], root);
  const s = readState(root);
  s["inny:facebook"].permalink = "https://x/7"; // symulacja zapisu publikatora między próbą a apply
  writeFileSync(join(root, "state", "published.json"), JSON.stringify(s, null, 2) + "\n");
  assert.throws(() => requeue(["k4:facebook"], { root, apply: true, expectSha256: sha, log: () => {} }), /stan zmienił się od próby/);
  assert.equal(readState(root)["k4:facebook"].status, "failed");
});

test("requeue: blokada pliku wyklucza drugi równoległy requeue, a po zapisie jest zwalniana", () => {
  const root = fixture([post()], { "k4:facebook": failedEntry({ history: probeHistory() }) });
  const sha = fromTry(["k4:facebook"], root);
  writeFileSync(join(root, "state", ".requeue.lock"), "");
  assert.throws(() => requeue(["k4:facebook"], { root, apply: true, expectSha256: sha, log: () => {} }), /inny requeue trwa/);
  assert.equal(readState(root)["k4:facebook"].status, "failed");
  rmSync(join(root, "state", ".requeue.lock")); // operator usuwa pozostałość po sprawdzeniu
  requeue(["k4:facebook"], { root, apply: true, expectSha256: sha, log: () => {} });
  assert.equal(readState(root)["k4:facebook"].status, undefined);
  assert.equal(existsSync(join(root, "state", ".requeue.lock")), false, "blokada zwolniona po zapisie");
});

test("requeue: brak dowodu 'przed API' wymaga potwierdzenia sprawdzenia platformy; brak id go nie zastępuje", () => {
  const root = fixture([post()], {
    "a:facebook": failedEntry({ error: "Temporary error" }),                               // brak historii
    "b:facebook": failedEntry({ history: [...probeHistory().slice(0, 2), { at: "x", stage: "publish", error: "e" }] }), // jeden wpis po API
    "c:facebook": failedEntry({ history: probeHistory().slice(0, 2) }),                    // historia niekompletna (2 z 3)
  });
  for (const k of ["a:facebook", "b:facebook", "c:facebook"]) {
    const sha = fromTry([k], root);
    assert.throws(() => requeue([k], { root, apply: true, expectSha256: sha, log: () => {} }), /brak dowodu/, k);
    assert.throws(() => requeue([k], { root, apply: true, expectSha256: sha, verifiedAbsent: "ok", log: () => {} }), /brak dowodu/, "zbyt krótkie potwierdzenie");
  }
  const sha = fromTry(["a:facebook"], root);
  requeue(["a:facebook"], { root, apply: true, expectSha256: sha, verifiedAbsent: "P. Nowak 10.11 15:00, FB i IG bez posta K4", log: () => {} });
  const s = readState(root)["a:facebook"];
  assert.equal(s.requeue_basis, "operator_verified");
  assert.match(s.verified_absent_on_platform, /P\. Nowak/);
  assert.equal(readState(root)["b:facebook"].status, "failed", "pozostałe klucze nietknięte");
});

test("requeue odmawia: wpis z id/permalinkiem, status inny niż failed, zły klucz, brak kluczy", () => {
  const root = fixture([post()], { "p:facebook": failedEntry({ id: "123" }), "q:facebook": { status: "published", id: "1" } });
  assert.throws(() => requeue(["p:facebook"], { root, log: () => {} }), /duplikat/);
  assert.throws(() => requeue(["q:facebook"], { root, log: () => {} }), /tylko "failed"/);
  assert.throws(() => requeue(["*"], { root, log: () => {} }), /zły klucz/);
  assert.throws(() => requeue([], { root, log: () => {} }), /co najmniej jeden/);
  assert.equal(existsSync(join(root, "state", ".requeue.lock")), false);
});

test("K4: 403 → failed po 3 próbach → naprawa hosta + requeue (dowód: historia probe) → jedna publikacja, bez duplikatu", async () => {
  const g = await mockServer();
  g.flags.block = ["/raw/", "/cdn/"];
  const root = fixture([post()]);
  for (let i = 0; i < 3; i++) await run(cdnEnv(g), { root, ...quiet });
  const failed = readState(root)["k4:facebook"];
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.history.map((h) => h.stage), ["probe", "probe", "probe"]);
  assert.equal(g.calls.filter((c) => c.path.includes("/PAGE")).length, 0, "przy 403 nic nie trafiło do Graph");

  g.flags.block = []; // naprawa hostingu
  const sha = fromTry(["k4:facebook"], root);
  requeue(["k4:facebook"], { root, apply: true, expectSha256: sha, log: () => {} });
  const r1 = await run(cdnEnv(g), { root, ...quiet });
  assert.deepEqual(r1.unresolved, []);
  assert.equal(readState(root)["k4:facebook"].status, "published");
  assert.equal(g.calls.filter((c) => c.path.endsWith("/PAGE/feed")).length, 1);

  await run(cdnEnv(g), { root, ...quiet });
  assert.equal(g.calls.filter((c) => c.path.endsWith("/PAGE/feed")).length, 1, "drugi przebieg nie dubluje posta");
  g.close();
});
