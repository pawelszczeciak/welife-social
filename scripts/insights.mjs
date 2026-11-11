// Raz dziennie zbiera wyniki publikacji z Instagrama, Facebooka i TikToka (przez Zernio) i zapisuje
// insights/latest.json. Same odczyty, kilka wywołań na przebieg (limit aplikacji Meta jest ciasny, patrz rate-limit.test.mjs).
// Automat treści czyta ten plik i robi więcej tego, co działa. Bez danych osobowych: same liczby dla postów.
//
// Zasięg, wyświetlenia, zapisy i czas oglądania wymagają uprawnień tokenu instagram_manage_insights
// (Instagram) i read_insights (Facebook). Bez nich zapisujemy to, co jest dostępne (polubienia, komentarze,
// obserwujący) i pole "missing" mówi, czego brakuje.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeGraph, loadQueue } from "./lib.mjs";
import { makeZernio, zernioConfigured, findTikTokAccount } from "./zernio.mjs";

const IG_BASE = "id,timestamp,permalink,media_type,media_product_type,like_count,comments_count";
const IG_METRICS = ["reach", "views", "saved", "shares", "total_interactions"];
const REEL_METRICS = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
const PERMISSION_CODES = new Set([10, 190, 200, 803]);
const isPermission = (e) => PERMISSION_CODES.has(e?.info?.code) || /permission|uprawnie/i.test(e?.message ?? "");

// Graph zwraca insights jako { data: [{ name, values: [{ value }] }] }.
const metricMap = (insights) =>
  Object.fromEntries((insights?.data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? null]));

// state/published.json: id publikacji na platformie → klucz kolejki (np. "2026-11-05-1230-r3").
function indexState(state, platform) {
  const byId = new Map();
  for (const [key, v] of Object.entries(state)) {
    if (!key.endsWith(`:${platform}`) || v.status !== "published" || !v.id) continue;
    const id = String(v.id);
    byId.set(id, key.slice(0, -platform.length - 1));
    byId.set(id.split("_").pop(), key.slice(0, -platform.length - 1));
  }
  return byId;
}

function describe(post) {
  if (!post) return {};
  const text = post.caption ?? post.facebook?.message ?? "";
  const hour = /T(\d\d:\d\d)/.exec(post.publish_at ?? "")?.[1] ?? null;
  return {
    type: post.type,
    lang: /-en$/.test(post.id) ? "en" : "pl",
    slot: hour,
    media: post.media?.[0]?.replace(/^media\//, "") ?? null,
    hook: text.split("\n")[0].slice(0, 120),
  };
}

async function instagram(graph, igUserId, { state, posts, log }) {
  const out = { followers: null, media_count: null, missing: [], posts: [] };
  const profile = await graph.get(igUserId, { fields: "username,followers_count,media_count" });
  out.username = profile.username ?? null;
  out.followers = profile.followers_count ?? null;
  out.media_count = profile.media_count ?? null;

  // Jedno wywołanie na stronę listy; przy błędzie metryki albo uprawnień schodzimy stopniowo do samych liczników.
  const attempts = [IG_METRICS, IG_METRICS.filter((m) => m !== "views"), null];
  let media = null;
  for (const metrics of attempts) {
    try {
      const fields = metrics ? `${IG_BASE},insights.metric(${metrics.join(",")})` : IG_BASE;
      media = [];
      let res = await graph.get(`${igUserId}/media`, { fields, limit: 50 });
      media.push(...(res.data ?? []));
      const after = res.paging?.cursors?.after;
      if (after && res.paging?.next) {
        res = await graph.get(`${igUserId}/media`, { fields, limit: 50, after });
        media.push(...(res.data ?? []));
      }
      if (!metrics) out.missing.push("instagram_manage_insights (zasięg, wyświetlenia, zapisy, udostępnienia)");
      break;
    } catch (e) {
      log(`Instagram: odczyt ${metrics ? `z metrykami ${metrics.join(",")}` : "podstawowy"} nieudany (${e.message})`);
      if (!metrics) throw e;
      if (isPermission(e)) attempts.splice(1, attempts.length - 2); // brak uprawnień: od razu wersja podstawowa
    }
  }

  // Czas oglądania jest tylko dla rolek, więc osobno i tylko gdy insights w ogóle działają.
  const watch = new Map();
  const reels = media.filter((m) => m.media_product_type === "REELS" && m.insights);
  for (let i = 0; i < reels.length && i < 100; i += 50) {
    try {
      const res = await graph.get("", { ids: reels.slice(i, i + 50).map((m) => m.id).join(","), fields: `insights.metric(${REEL_METRICS.join(",")})` });
      for (const [id, v] of Object.entries(res)) watch.set(id, metricMap(v.insights));
    } catch (e) {
      log(`Instagram: czas oglądania rolek nieodczytany (${e.message})`);
      break;
    }
  }

  const byId = indexState(state, "instagram");
  for (const m of media) {
    const key = byId.get(String(m.id)) ?? null;
    const ins = metricMap(m.insights);
    const w = watch.get(m.id) ?? {};
    out.posts.push({
      key, id: m.id, permalink: m.permalink ?? null, published_at: m.timestamp ?? null,
      kind: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "image",
      ...describe(posts.get(key)),
      likes: m.like_count ?? null, comments: m.comments_count ?? null,
      reach: ins.reach ?? null, views: ins.views ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null,
      interactions: ins.total_interactions ?? null,
      avg_watch_s: w.ig_reels_avg_watch_time != null ? Math.round(w.ig_reels_avg_watch_time / 100) / 10 : null,
    });
  }
  return out;
}

async function facebook(graph, pageId, { state, posts, log }) {
  const out = { followers: null, missing: [], posts: [] };
  const page = await graph.get(pageId, { fields: "access_token,followers_count,fan_count" });
  out.followers = page.followers_count ?? page.fan_count ?? null;
  const token = page.access_token;
  const byId = indexState(state, "facebook");
  const count = (edge) => edge?.summary?.total_count ?? null;
  const engagement = "likes.summary(true).limit(0),comments.summary(true).limit(0)";

  try {
    const res = await graph.get(`${pageId}/videos`, { fields: `id,created_time,views,${engagement}`, limit: 100 }, token);
    for (const v of res.data ?? []) {
      const key = byId.get(String(v.id)) ?? null;
      out.posts.push({ key, id: v.id, published_at: v.created_time ?? null, kind: "reel", ...describe(posts.get(key)), views: v.views ?? null, reactions: count(v.likes), comments: count(v.comments), shares: null, reach: null });
    }
  } catch (e) {
    log(`Facebook: filmy nieodczytane (${e.message})`);
    out.missing.push(`filmy: ${e.message}`);
  }

  const base = `id,created_time,shares,${engagement}`;
  for (const withReach of [true, false]) {
    try {
      const fields = withReach ? `${base},insights.metric(post_impressions_unique)` : base;
      const res = await graph.get(`${pageId}/posts`, { fields, limit: 100 }, token);
      const videoKeys = new Set(out.posts.map((p) => p.key).filter(Boolean));
      for (const p of res.data ?? []) {
        const key = byId.get(String(p.id)) ?? byId.get(String(p.id).split("_").pop()) ?? null;
        if (key && videoKeys.has(key)) continue; // rolka: policzona jako film
        if (!key) continue; // wpis strony spoza kolejki albo rolka widziana drugi raz jako post
        out.posts.push({ key, id: p.id, published_at: p.created_time ?? null, kind: posts.get(key)?.type ?? "post", ...describe(posts.get(key)), views: null, reactions: count(p.likes), comments: count(p.comments), shares: p.shares?.count ?? 0, reach: metricMap(p.insights).post_impressions_unique ?? null });
      }
      if (!withReach) out.missing.push("read_insights (zasięg postów)");
      break;
    } catch (e) {
      log(`Facebook: posty ${withReach ? "z zasięgiem" : "bez zasięgu"} nieodczytane (${e.message})`);
      if (!withReach) out.missing.push(`posty: ${e.message}`);
    }
  }
  return out;
}

// TikTok przez Zernio: GET /analytics (wyświetlenia, polubienia, komentarze, udostępnienia; dane z opóźnieniem
// do 60 min) i liczba obserwujących z /analytics/tiktok/account-insights. Dwa wywołania.
async function tiktok(call, env, { state, posts, log }) {
  const out = { followers: null, missing: [], posts: [] };
  const byId = indexState(state, "tiktok");
  const res = await call("GET", "/analytics?platform=tiktok&limit=100");
  if (res.status !== 200) throw new Error(`Zernio /analytics: HTTP ${res.status} ${res.json?.error ?? res.json?.message ?? ""}`.trim());
  const rows = res.json.posts ?? res.json.data ?? [];
  if (rows.length === 0) log(`TikTok: brak postów w odpowiedzi Zernio (pola: ${Object.keys(res.json).join(", ")})`);
  for (const r of rows) {
    const ids = [r._id, r.postId, r.id, r.latePostId].filter(Boolean).map(String);
    const key = ids.map((i) => byId.get(i)).find(Boolean) ?? null;
    const tt = (r.platformAnalytics ?? r.platforms ?? []).find((x) => String(x.platform).toLowerCase() === "tiktok") ?? {};
    const a = { ...(tt.analytics ?? {}), ...(r.analytics ?? {}) };
    out.posts.push({
      key, id: ids[0] ?? null, permalink: tt.platformPostUrl ?? r.platformPostUrl ?? null, published_at: r.publishedAt ?? null,
      kind: "reel", ...describe(posts.get(key)),
      views: a.views ?? null, likes: a.likes ?? null, comments: a.comments ?? null, shares: a.shares ?? null,
    });
  }
  try {
    const account = await findTikTokAccount(env, call);
    const ins = await call("GET", `/analytics/tiktok/account-insights?accountId=${encodeURIComponent(account.id)}&metrics=follower_count`);
    if (ins.status === 200) out.followers = ins.json.metrics?.follower_count?.total ?? null;
    else out.missing.push(`obserwujący TikTok: HTTP ${ins.status}`);
  } catch (e) {
    out.missing.push(`obserwujący TikTok: ${e.message}`);
  }
  return out;
}

const sum = (rows, f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0);
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// Zestawienie, z którego korzysta człowiek i automat treści: mediany w grupach i najlepsze/najsłabsze posty.
export function summarize(data) {
  const out = {};
  for (const platform of ["instagram", "facebook", "tiktok"]) {
    if (data[platform]?.posts) out[platform] = summarizePlatform(data[platform].posts);
  }
  return out;
}

function summarizePlatform(ig) {
  const metric = ig.some((p) => p.views != null) ? "views" : ig.some((p) => p.reach != null) ? "reach" : ig.some((p) => p.likes != null) ? "likes" : "reactions";
  const group = (rows, by) => {
    const g = new Map();
    for (const r of rows) {
      const k = by(r);
      if (k == null) continue;
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    return Object.fromEntries([...g].map(([k, rs]) => [k, { n: rs.length, median: median(rs.map((r) => r[metric])), total: sum(rs, metric), likes: sum(rs, "likes") + sum(rs, "reactions"), comments: sum(rs, "comments"), saved: sum(rs, "saved"), shares: sum(rs, "shares") }]));
  };
  const ranked = ig.filter((p) => p[metric] != null).sort((a, b) => b[metric] - a[metric]);
  const brief = (p) => ({ key: p.key, kind: p.kind, lang: p.lang, slot: p.slot, [metric]: p[metric], likes: p.likes ?? p.reactions, saved: p.saved, shares: p.shares, avg_watch_s: p.avg_watch_s, hook: p.hook });
  return {
    metric,
    posts: ig.length,
    by_kind: group(ig, (p) => p.kind),
    by_lang: group(ig, (p) => p.lang),
    by_slot: group(ig, (p) => p.slot),
    top: ranked.slice(0, 5).map(brief),
    bottom: ranked.slice(-5).reverse().map(brief),
  };
}

export async function collect({ graph, igUserId, pageId, zernio = null, env = {}, root, now = Date.now(), log = console.log }) {
  const state = JSON.parse(readFileSync(join(root, "state", "published.json"), "utf8"));
  const posts = new Map(loadQueue(join(root, "queue")).map((p) => [p.id, p]));
  const data = { collected_at: new Date(now).toISOString() };
  for (const [name, fn, id] of [["instagram", instagram, igUserId], ["facebook", facebook, pageId]]) {
    if (!id) continue;
    try {
      data[name] = await fn(graph, id, { state, posts, log });
    } catch (e) {
      log(`${name}: nie odczytano (${e.message})`);
      data[name] = { error: e.message };
    }
  }
  if (zernio) {
    try {
      data.tiktok = await tiktok(zernio, env, { state, posts, log });
    } catch (e) {
      log(`tiktok: nie odczytano (${e.message})`);
      data.tiktok = { error: e.message };
    }
  }
  data.summary = summarize(data);
  data.api_usage = graph.usage?.() ?? null;
  return data;
}

export function save(root, data) {
  const dir = join(root, "insights");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest.json"), JSON.stringify(data, null, 2) + "\n");
  const ig = data.instagram ?? {};
  const fb = data.facebook ?? {};
  const line = {
    date: data.collected_at.slice(0, 10),
    ig_followers: ig.followers ?? null, ig_posts: ig.posts?.length ?? null,
    ig_views: ig.posts ? sum(ig.posts, "views") : null, ig_reach: ig.posts ? sum(ig.posts, "reach") : null,
    ig_likes: ig.posts ? sum(ig.posts, "likes") : null, ig_comments: ig.posts ? sum(ig.posts, "comments") : null,
    fb_followers: fb.followers ?? null, fb_views: fb.posts ? sum(fb.posts, "views") : null,
    tt_followers: data.tiktok?.followers ?? null, tt_posts: data.tiktok?.posts?.length ?? null,
    tt_views: data.tiktok?.posts ? sum(data.tiktok.posts, "views") : null, tt_likes: data.tiktok?.posts ? sum(data.tiktok.posts, "likes") : null,
  };
  const history = join(dir, "history.jsonl");
  const lines = existsSync(history) ? readFileSync(history, "utf8").split("\n").filter(Boolean) : [];
  const kept = lines.filter((l) => !l.includes(`"date":"${line.date}"`)); // jeden wiersz na dzień
  writeFileSync(history, [...kept, JSON.stringify(line)].join("\n") + "\n");
  return line;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  if (!env.META_ACCESS_TOKEN) {
    console.error("brak sekretu META_ACCESS_TOKEN");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const graph = makeGraph({ base: env.GRAPH_BASE || undefined, version: env.GRAPH_VERSION || undefined, token: env.META_ACCESS_TOKEN });
  const zernio = zernioConfigured(env) ? makeZernio(env) : null;
  const data = await collect({ graph, igUserId: env.IG_USER_ID, pageId: env.FB_PAGE_ID, zernio, env, root });
  const line = save(root, data);
  console.log(`zapisane: ${JSON.stringify(line)}`);
  console.log(`podsumowanie: ${JSON.stringify(data.summary)}`);
  for (const p of ["instagram", "facebook", "tiktok"]) for (const m of data[p]?.missing ?? []) console.log(`BRAK (${p}): ${m}`);
  if (data.instagram?.error && data.facebook?.error) process.exit(1);
}
