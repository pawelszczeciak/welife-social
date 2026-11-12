// Sprawdza konfigurację automatu: ważność i uprawnienia tokenu, stronę FB i połączone konto IG.
// Kończy się błędem (czerwony przebieg = e-mail z GitHuba), gdy coś wymaga Twojej uwagi,
// np. token wygasa za mniej niż 10 dni.
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { makeGraph, loadQueue, textFor, findInstagramByCaption } from "./lib.mjs";
import { tiktokConfigured, getTikTokAccess, creatorInfo, readVault } from "./tiktok.mjs";
import { zernioConfigured, makeZernio, findTikTokAccount, tiktokCreatorInfo, findYouTubeAccount, findPinterestAccount, PINTEREST_BOARD } from "./zernio.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "pages_manage_posts"];

// opts.metaOnly (albo --meta-only / CHECK_META_ONLY=true): tylko Facebook/Instagram, bez żadnego wywołania
// TikToka ani Zernio (bez odświeżania i rotacji tokenów). Workflow "Diagnostyka Meta" uruchamia wyłącznie to.
export async function check(env = process.env, opts = {}) {
  const metaOnly = opts.metaOnly === true || env.CHECK_META_ONLY === "true";
  const { problems } = await checkMeta(env, { log: console.log, fetchImpl: fetch, now: Date.now(), root: ROOT, ...opts });
  if (metaOnly) console.log("TikTok: pominięty (tylko diagnostyka Meta)");
  else problems.push(...(await checkTikTok(env, { log: console.log, fetchImpl: fetch, now: Date.now(), root: ROOT, ...opts })));
  return { problems };
}

// TikTok przez Zernio: konto podłączone w Zernio i dozwolona prywatność.
async function checkZernio(env, { log, fetchImpl }) {
  const problems = [];
  try {
    const call = makeZernio(env, fetchImpl);
    const account = await findTikTokAccount(env, call);
    const info = await tiktokCreatorInfo(call, account.id);
    const options = (info.privacyLevels ?? []).map((p) => p.value);
    const name = info.creator?.nickname ?? account.name ?? "?";
    log(`TikTok (Zernio): ${name} · konto ${account.id} · prywatność: ${options.join(", ") || "(brak)"}`);
    const privacy = env.TIKTOK_PRIVACY || "PUBLIC_TO_EVERYONE";
    if (options.length && !options.includes(privacy)) {
      problems.push(`TikTok (Zernio): TIKTOK_PRIVACY=${privacy} nie jest dostępne dla konta (${options.join(", ")})`);
    }
    if (info.creator && info.creator.canPostMore === false) problems.push("TikTok (Zernio): konto chwilowo nie może publikować (limit TikToka)");
  } catch (e) {
    problems.push(`TikTok (Zernio): ${e.message}`);
  }
  // YouTube jest opcjonalny: brak kanału to informacja, nie problem.
  try {
    const yt = await findYouTubeAccount(env, makeZernio(env, fetchImpl));
    log(yt ? `YouTube (Zernio): kanał ${yt.name ?? "?"} · konto ${yt.id}` : "YouTube (Zernio): kanał nie jest podłączony, rolki na YouTube są pomijane");
  } catch (e) {
    problems.push(`YouTube (Zernio): ${e.message}`);
  }
  // Pinterest też jest opcjonalny. Tylko odczyt: tablicy tu nie zakładamy (robi to pierwsza publikacja).
  try {
    const call = makeZernio(env, fetchImpl);
    const pin = await findPinterestAccount(env, call);
    if (!pin) log("Pinterest (Zernio): konto nie jest podłączone, piny są pomijane");
    else {
      const res = await call("GET", `/accounts/${encodeURIComponent(pin.id)}/pinterest-boards`);
      const names = (res.json.boards ?? []).map((b) => b.name);
      const want = env.PINTEREST_BOARD_NAME || PINTEREST_BOARD.name;
      const has = env.PINTEREST_BOARD_ID || names.some((n) => String(n).trim().toLowerCase() === want.trim().toLowerCase());
      log(`Pinterest (Zernio): ${pin.name ?? "?"} · konto ${pin.id} · tablice: ${names.join(", ") || "(brak)"} · ${has ? "tablica na piny jest" : `tablica „${want}” zostanie założona przy pierwszym pinie`}`);
      if (res.status !== 200) problems.push(`Pinterest (Zernio): nie da się odczytać tablic (HTTP ${res.status})`);
    }
  } catch (e) {
    problems.push(`Pinterest (Zernio): ${e.message}`);
  }
  return problems;
}

// TikTok jest opcjonalny: bez sekretów tylko odnotowujemy, że go nie ma.
// Zernio ma pierwszeństwo; bezpośrednie API sprawdzamy tylko bez Zernio (każde sprawdzenie rotuje jego token).
async function checkTikTok(env, { log, fetchImpl, now, root }) {
  if (zernioConfigured(env)) return checkZernio(env, { log, fetchImpl });
  if (!tiktokConfigured(env)) {
    log("TikTok: nie skonfigurowany");
    return [];
  }
  const problems = [];
  try {
    const { accessToken, refreshed } = await getTikTokAccess(env, { root, fetchImpl, now });
    if (refreshed) log("TikTok: odświeżono token, nowy refresh token zapisany zaszyfrowany w vault/");
    const info = await creatorInfo(env, accessToken, fetchImpl);
    const options = info.privacy_level_options ?? [];
    log(`TikTok: @${info.creator_username ?? "?"} · prywatność: ${options.join(", ") || "(brak)"} · maks. długość filmu: ${info.max_video_post_duration_sec ?? "?"} s`);
    const privacy = env.TIKTOK_PRIVACY || "SELF_ONLY";
    if (!options.includes(privacy)) problems.push(`TikTok: TIKTOK_PRIVACY=${privacy} nie jest dostępne dla konta (${options.join(", ")})`);
    const vault = readVault(root, env);
    if (vault?.refresh_expires_at) {
      const days = Math.floor((vault.refresh_expires_at - now) / 86400000);
      log(`TikTok: refresh token ważny jeszcze ${days} dni (odnawia się przy każdej publikacji)`);
      if (days < 14) problems.push(`TikTok: refresh token wygasa za ${days} dni: uruchom scripts/tiktok-auth.mjs`);
    }
  } catch (e) {
    problems.push(`TikTok: ${e.message}`);
  }
  return problems;
}

// Tylko odczyt (same GET): limit publikacji IG, zużycie limitów zapytań Meta, posty z identycznym opisem
// i obecność pozycji IG "failed"/"retry" na koncie. Błąd albo niepewny wynik sprawdzenia obecności to PROBLEM
// ("nie można potwierdzić"), nigdy dowód nieobecności. Problemem jest też post znaleziony mimo failed/retry.
async function igPublishingDiagnostics(graph, igId, { log, root }) {
  const problems = [];
  try {
    const { data = [] } = await graph.get(`${igId}/content_publishing_limit`, { fields: "quota_usage,config" });
    const q = data[0] ?? {};
    log(`IG limit publikacji: ${q.quota_usage ?? "?"}/${q.config?.quota_total ?? "?"} w ${Math.round((q.config?.quota_duration ?? 86400) / 3600)} h`);
  } catch (e) {
    log(`IG limit publikacji: nie odczytano (${e.message})`);
  }
  try {
    const { data: media = [] } = await graph.get(`${igId}/media`, { fields: "id,caption,timestamp,permalink", limit: 50 });
    // Ten sam opis więcej niż raz = prawdopodobny duplikat (K4 PL: 3 kopie). Tylko informacja; usuwa człowiek.
    const groups = new Map();
    for (const m of media) {
      const k = (m.caption ?? "").replace(/\s+/g, " ").trim();
      if (k) groups.set(k, [...(groups.get(k) ?? []), m]);
    }
    for (const copies of groups.values()) {
      if (copies.length > 1) log(`UWAGA: ${copies.length} posty IG z identycznym opisem: ${copies.map((m) => `${m.id}${m.permalink ? ` ${m.permalink}` : ""} (${m.timestamp ?? "?"})`).join(", ")}`);
    }
  } catch (e) {
    log(`IG ostatnie posty: nie odczytano (${e.message})`);
  }
  for (const p of pendingInstagram(root)) {
    try {
      const r = await findInstagramByCaption(graph, igId, p.caption, p.since);
      if (r.status === "found") problems.push(`${p.key} ma status ${p.status}, a post JEST na Instagramie (${r.permalink ?? r.id}; kopii: ${r.copies.length}): nie wznawiaj, ryzyko duplikatu`);
      else if (r.status === "absent") log(`${p.key} (${p.status}): brak na koncie od ${new Date(p.since).toISOString()} (rozstrzygające: lista sięga przed tę datę)`);
      else problems.push(`${p.key} (${p.status}): nie można potwierdzić nieobecności na Instagramie (${r.reason}); to nie jest dowód, że posta nie ma`);
    } catch (e) {
      problems.push(`${p.key} (${p.status}): nie można potwierdzić nieobecności na Instagramie (błąd odczytu: ${e.message}); to nie jest dowód, że posta nie ma`);
    }
  }
  const u = graph.usage();
  log(`zużycie limitów Meta (ostatni nagłówek): aplikacja ${u.app ?? "(brak nagłówka)"} · BUC ${bucSummary(u.buc)}`);
  return problems;
}

// Pozycje IG "failed"/"retry" z ich opisem i dolną granicą czasu: pierwszy kontener albo termin posta.
function pendingInstagram(root) {
  const statePath = join(root, "state", "published.json");
  if (!existsSync(statePath) || !existsSync(join(root, "queue"))) return [];
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const posts = new Map(loadQueue(join(root, "queue")).map((p) => [p.id, p]));
  const out = [];
  for (const [key, e] of Object.entries(state)) {
    if (!key.endsWith(":instagram") || !["failed", "retry"].includes(e?.status)) continue;
    const post = posts.get(key.slice(0, -":instagram".length));
    if (!post) continue;
    const created = Date.parse(e.creation_at);
    out.push({ key, status: e.status, caption: textFor(post, "instagram"), since: Number.isFinite(created) ? Math.min(created, Date.parse(post.publish_at)) : Date.parse(post.publish_at) });
  }
  return out;
}

// Bez identyfikatorów kont (logi publicznego repo): tylko najwyższe procenty i czas do odblokowania.
function bucSummary(raw) {
  if (!raw) return "(brak nagłówka)";
  try {
    const rows = Object.values(JSON.parse(raw)).flat();
    const max = (k) => Math.max(0, ...rows.map((r) => Number(r?.[k]) || 0));
    return `max call_count ${max("call_count")}%, cputime ${max("total_cputime")}%, time ${max("total_time")}%, odblokowanie za ${max("estimated_time_to_regain_access")} min`;
  } catch {
    return "(nieczytelny)";
  }
}

async function checkMeta(env, { log, fetchImpl, now, root }) {
  const problems = [];
  if (!env.META_ACCESS_TOKEN) return { problems: ["brak sekretu META_ACCESS_TOKEN"] };
  const graph = makeGraph({ base: env.GRAPH_BASE || undefined, version: env.GRAPH_VERSION || undefined, token: env.META_ACCESS_TOKEN, fetchImpl });

  const { data: info } = await graph.get("debug_token", { input_token: env.META_ACCESS_TOKEN });
  if (!info?.is_valid) problems.push("token jest nieważny");
  const expires = Number(info?.expires_at ?? 0);
  if (expires === 0) log("token: bez daty wygaśnięcia");
  else {
    const days = Math.floor((expires * 1000 - now) / 86400000);
    log(`token: wygasa za ${days} dni (${new Date(expires * 1000).toISOString().slice(0, 10)})`);
    if (days < 10) problems.push(`token wygasa za ${days} dni: wygeneruj nowy i podmień sekret META_ACCESS_TOKEN`);
  }
  const scopes = info?.scopes ?? [];
  const missing = REQUIRED.filter((s) => !scopes.includes(s));
  if (missing.length) problems.push(`brak uprawnień tokenu: ${missing.join(", ")}`);

  if (!env.FB_PAGE_ID) {
    const { data: pages = [] } = await graph.get("me/accounts", { fields: "id,name,instagram_business_account{id,username}" });
    for (const p of pages) log(`strona: ${p.name} · FB_PAGE_ID=${p.id} · IG_USER_ID=${p.instagram_business_account?.id ?? "(brak połączonego IG)"}`);
    problems.push("brak FB_PAGE_ID: wpisz go z listy wyżej jako sekret repo");
    return { problems };
  }
  const page = await graph.get(env.FB_PAGE_ID, { fields: "name,instagram_business_account{id,username}" });
  const ig = page.instagram_business_account;
  log(`strona: ${page.name} · IG: ${ig ? `@${ig.username} (${ig.id})` : "brak połączonego konta"}`);
  if (!ig) problems.push("strona nie jest połączona z kontem Instagram (Meta Business Suite → Ustawienia → Konta)");
  else if (env.IG_USER_ID && env.IG_USER_ID !== ig.id) problems.push(`IG_USER_ID=${env.IG_USER_ID} nie pasuje do konta strony (${ig.id})`);
  else if (!env.IG_USER_ID) problems.push(`brak IG_USER_ID: ustaw sekret na ${ig.id}`);
  // Posty kierują do „linku w bio”, więc bez niego cały ruch z Instagrama przepada.
  if (ig) {
    const profile = await graph.get(ig.id, { fields: "username,biography,website" });
    log(`bio IG: ${(profile.biography ?? "").replace(/\s+/g, " ").slice(0, 80) || "(puste)"} · link: ${profile.website ?? "(brak)"}`);
    if (!/welife\.world/i.test(profile.website ?? "")) {
      problems.push("w bio Instagrama brakuje linku do welife.world: ustaw go w aplikacji (Edytuj profil → Linki)");
    }
    problems.push(...(await igPublishingDiagnostics(graph, ig.id, { log, root })));
  }
  return { problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  check(process.env, { metaOnly: process.argv.includes("--meta-only") })
    .then(({ problems }) => {
      for (const p of problems) console.log(`DO ZROBIENIA: ${p}`);
      if (!problems.length) console.log("Konfiguracja OK.");
      process.exit(problems.length ? 1 : 0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
