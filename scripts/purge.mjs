// Usuwa z platform publikacje sprzed podanej chwili (np. wszystko w starej szacie graficznej) i oznacza je
// w state/published.json jako "removed". Uruchamiane ręcznie z GitHub Actions („Usuń stare publikacje”).
//
// Co się da usunąć przez API:
//   facebook  – Graph API DELETE (filmy i posty strony);
//   youtube   – Zernio POST /posts/{id}/unpublish (trwale kasuje film);
//   pinterest – Zernio unpublish;
//   instagram – Graph API zwykle NIE pozwala usuwać mediów; skrypt próbuje raz i, jeśli Meta odmówi,
//               wypisuje listę adresów do ręcznego usunięcia (także postów spoza kolejki, np. duplikatów);
//   tiktok    – nie da się (ani API TikToka, ani Zernio); skrypt tylko wypisuje, ile ich jest.
//
// Bezpieczniki: tylko wpisy "published" z terminem PRZED chwilą BEFORE (nowe publikacje są nietykalne),
// DRY_RUN=true niczego nie usuwa, LIMIT ogranicza liczbę usunięć na przebieg (limity zapytań Meta).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeGraph, loadQueue, sameCaption } from "./lib.mjs";
import { makeZernio, zernioConfigured } from "./zernio.mjs";

const VIA_ZERNIO = new Set(["youtube", "pinterest"]);
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

// Wpisy danej platformy opublikowane przed granicą, najstarsze najpierw.
export function candidates(state, posts, platform, before) {
  const due = new Map(posts.map((p) => [p.id, Date.parse(p.publish_at)]));
  const out = [];
  for (const [key, e] of Object.entries(state)) {
    if (!key.endsWith(`:${platform}`) || e.status !== "published" || !e.id) continue;
    const postId = key.slice(0, -platform.length - 1);
    const when = Date.parse(e.published_at ?? "") || due.get(postId) || Date.parse(e.updated_at ?? "");
    if (!(when < before)) continue;
    out.push({ key, id: String(e.id), permalink: e.permalink ?? null, when });
  }
  return out.sort((a, b) => a.when - b.when);
}

export async function purge({ platforms, before, state, posts, graph, pageId, igUserId, zernio, dryRun = false, limit = 25, reason = "usunięte z platformy", now = Date.now(), log = console.log }) {
  const report = { removed: [], failed: [], manual: [], skipped: [] };
  let budget = limit;
  const mark = (c) => {
    state[c.key] = { ...state[c.key], status: "removed", removed_at: new Date(now).toISOString(), note: reason };
    report.removed.push(c.key);
  };

  for (const platform of platforms) {
    const list = candidates(state, posts, platform, before);
    if (platform === "tiktok") {
      if (list.length) report.manual.push(...list.map((c) => ({ platform, key: c.key, permalink: c.permalink })));
      log(`TikTok: ${list.length} filmów do usunięcia ręcznie (API TikToka ani Zernio nie pozwalają kasować)`);
      continue;
    }
    if (platform === "instagram") {
      // Lista z konta, żeby objąć także posty spoza kolejki (duplikaty). Jedno wywołanie na 100 pozycji.
      let media = [];
      try {
        let res = await graph.get(`${igUserId}/media`, { fields: "id,timestamp,permalink,caption", limit: 100 });
        media = res.data ?? [];
        if (res.paging?.next && res.paging?.cursors?.after) {
          res = await graph.get(`${igUserId}/media`, { fields: "id,timestamp,permalink,caption", limit: 100, after: res.paging.cursors.after });
          media.push(...(res.data ?? []));
        }
      } catch (e) {
        log(`Instagram: nie odczytano listy postów (${e.message})`);
        report.failed.push({ platform, key: null, error: e.message });
        continue;
      }
      const byId = new Map(list.map((c) => [c.id, c]));
      // Tylko to, co wrzucił automat: wpis ze stanu albo kopia posta z kolejki (ten sam opis). Cudzych postów
      // (np. dodanych ręcznie przez właściciela) nie ruszamy, tylko je wypisujemy.
      const ours = (m) => byId.has(String(m.id)) || posts.some((p) => sameCaption(p.caption, m.caption));
      const before_ = media.filter((m) => Date.parse(m.timestamp) < before);
      const old = before_.filter(ours);
      for (const m of before_.filter((x) => !ours(x))) {
        log(`ZOSTAWIONE instagram ${m.permalink ?? m.id}: nie pochodzi z kolejki`);
        report.skipped.push(`instagram:${m.id}`);
      }
      log(`Instagram: ${old.length} postów automatu sprzed granicy (w tym ${old.filter((m) => byId.has(String(m.id))).length} zapisanych w stanie)`);
      let supported = true;
      for (const m of old) {
        const c = byId.get(String(m.id));
        if (dryRun) {
          log(`PRÓBA instagram ${m.permalink ?? m.id}`);
          continue;
        }
        if (!supported || budget <= 0) {
          report.manual.push({ platform, key: c?.key ?? null, permalink: m.permalink ?? null });
          continue;
        }
        try {
          await graph.del(String(m.id));
          budget--;
          if (c) mark(c);
          else report.removed.push(`instagram:${m.id}`);
          log(`USUNIĘTE instagram ${m.permalink ?? m.id}`);
        } catch (e) {
          // Pierwsza odmowa = Meta nie pozwala usuwać mediów przez API; reszta idzie na listę ręczną.
          supported = false;
          log(`Instagram: API odmawia usuwania (${e.message}); pozostałe do usunięcia ręcznie`);
          report.manual.push({ platform, key: c?.key ?? null, permalink: m.permalink ?? null });
        }
      }
      continue;
    }
    if (VIA_ZERNIO.has(platform) && !zernio) {
      log(`${platform}: brak ZERNIO_API_KEY, pomijam ${list.length} pozycji`);
      report.skipped.push(...list.map((c) => c.key));
      continue;
    }
    let pageToken = null;
    for (const c of list) {
      if (dryRun) {
        log(`PRÓBA ${platform} ${c.key} (${c.permalink ?? c.id})`);
        continue;
      }
      if (budget <= 0) {
        report.skipped.push(c.key);
        continue;
      }
      try {
        if (platform === "facebook") {
          pageToken ??= (await graph.get(pageId, { fields: "access_token" })).access_token;
          await graph.del(c.id, {}, pageToken);
        } else {
          const res = await zernio("POST", `/posts/${encodeURIComponent(c.id)}/unpublish`, { body: { platform } });
          if (res.status !== 200) throw new Error(`Zernio unpublish: HTTP ${res.status} ${res.json?.error ?? res.json?.message ?? ""}`.trim());
        }
        budget--;
        mark(c);
        log(`USUNIĘTE ${platform} ${c.key}`);
      } catch (e) {
        // Obiekt, którego już nie ma na Facebooku (usunięty ręcznie), też uznajemy za usunięty.
        if (platform === "facebook" && /does not exist|Unsupported delete request|nonexisting field/i.test(e.message) && e.info?.code === 100) {
          mark(c);
          log(`JUŻ NIE MA ${platform} ${c.key}`);
        } else {
          report.failed.push({ platform, key: c.key, error: e.message });
          log(`BŁĄD ${platform} ${c.key}: ${e.message}`);
        }
      }
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const before = Date.parse(env.BEFORE ?? "");
  const platforms = (env.PLATFORMS ?? "").split(/[\s,]+/).filter(Boolean);
  if (Number.isNaN(before) || platforms.length === 0) {
    console.error("podaj BEFORE (data ISO, np. 2026-11-14T01:00:00Z) i PLATFORMS (np. facebook,youtube)");
    process.exit(2);
  }
  const statePath = join(root, "state", "published.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const dryRun = env.DRY_RUN === "true";
  const report = await purge({
    platforms, before, state, posts: loadQueue(join(root, "queue")),
    graph: makeGraph({ version: env.GRAPH_VERSION || "v23.0", token: env.META_ACCESS_TOKEN }),
    pageId: env.FB_PAGE_ID, igUserId: env.IG_USER_ID,
    zernio: zernioConfigured(env) ? makeZernio(env) : null,
    dryRun, limit: Number(env.LIMIT || 25), reason: env.REASON || "usunięte z platformy",
  });
  if (!dryRun && report.removed.length) writeFileSync(statePath, JSON.stringify(sortKeys(state), null, 2) + "\n");
  console.log(`PODSUMOWANIE: usunięte ${report.removed.length}, błędy ${report.failed.length}, do usunięcia ręcznie ${report.manual.length}, odłożone (limit) ${report.skipped.length}`);
  for (const m of report.manual) console.log(`RĘCZNIE ${m.platform} ${m.permalink ?? m.key}`);
  if (report.failed.length) process.exit(1);
}
