// Publikuje posty z queue/, których czas minął, na Instagram, stronę FB, TikTok, YouTube Shorts i Pinterest
// (TikTok przez Zernio, gdy jest ZERNIO_API_KEY; inaczej bezpośrednio, tylko prywatnie; YouTube i Pinterest
// tylko przez Zernio).
// Domyślnie TRYB PRÓBNY: nic nie wysyła, tylko wypisuje, co by zrobił.
// Na żywo dopiero gdy PUBLISH_LIVE=true (zmienna repo w GitHub Actions).
//
// Stan publikacji: state/published.json (jedno wejście na post i platformę),
// dzięki czemu drugi przebieg nie publikuje tego samego drugi raz.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadQueue, validate, makeGraph, publishInstagram, publishFacebook } from "./lib.mjs";
import { tiktokConfigured, getTikTokAccess, publishTikTok } from "./tiktok.mjs";
import { zernioConfigured, makeZernio, findTikTokAccount, publishTikTokZernio, findYouTubeAccount, publishYouTubeZernio, findPinterestAccount, publishPinterestZernio } from "./zernio.mjs";

// Platformy opcjonalne, tylko przez Zernio: bez podłączonego konta pozycja czeka (bez zużywania prób)
// i po 24 h jest pomijana.
const OPTIONAL = {
  youtube: { name: "YouTube", find: findYouTubeAccount, publish: publishYouTubeZernio, missing: "w Zernio nie ma podłączonego kanału YouTube" },
  pinterest: { name: "Pinterest", find: findPinterestAccount, publish: publishPinterestZernio, missing: "w Zernio nie ma podłączonego konta Pinterest" },
};

const HOUR = 3600 * 1000;

export async function run(env = process.env, { root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), log = console.log, fetchImpl = fetch, waitOpts } = {}) {
  const live = env.PUBLISH_LIVE === "true";
  const now = env.NOW ? Date.parse(env.NOW) : Date.now();
  const staleMs = Number(env.STALE_HOURS ?? 24) * HOUR;
  const maxAttempts = Number(env.MAX_ATTEMPTS ?? 3);
  // Po błędzie limitu zapytań Meta czekamy co najmniej RATE_LIMIT_BACKOFF_MINUTES (domyślnie 60, jak okno kroczące
  // limitu aplikacji) albo dłużej, jeśli Meta podała szacowany czas odblokowania. To okno bezpieczeństwa, a nie
  // gwarancja, że każdy rodzaj limitu Meta odnawia się w godzinę. Zła wartość zmiennej = domyślne 60 min.
  const rateLimitBackoffMs = backoffMinutes(env.RATE_LIMIT_BACKOFF_MINUTES) * 60 * 1000;
  const statePath = join(root, "state", "published.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  // Puste zmienne repo przychodzą z Actions jako "", więc || zamiast ??.
  // Hosty plików dla Mety, w kolejności prób. Jawny MEDIA_BASE_URL to jedyny host (bez zmian).
  // Domyślnie: jsDelivr odrzuca (403 "Package size exceeded 50 MB") wszystko spoza cache, gdy repo
  // przekracza 50 MB (media tego repo to ponad 200 MB), więc zdjęcia idą najpierw z GitHub raw
  // (poprawny image/jpeg), a rolki z jsDelivr (raw podaje mp4 jako application/octet-stream).
  // YouTube i Pinterest przez Zernio: Zernio koduje „@” w adresie pliku jako %40, a jsDelivr odpowiada na to 400
  // („Failed to fetch video … welife-social%40<sha> …: 400”, 13.11.2026), więc te platformy dostają tylko adres
  // bez „@”, czyli GitHub raw (mp4 ma tam typ application/octet-stream).
  const mediaBases = (post, platform) => {
    if (env.MEDIA_BASE_URL) return [env.MEDIA_BASE_URL];
    if (!(env.GITHUB_REPOSITORY && env.GITHUB_SHA)) return [];
    const raw = `${env.RAW_MEDIA_HOST || "https://raw.githubusercontent.com"}/${env.GITHUB_REPOSITORY}/${env.GITHUB_SHA}/`;
    const cdn = `${env.JSDELIVR_MEDIA_HOST || "https://cdn.jsdelivr.net"}/gh/${env.GITHUB_REPOSITORY}@${env.GITHUB_SHA}/`;
    if (OPTIONAL[platform]) return [raw];
    return post.type === "reel" ? [cdn, raw] : [raw, cdn];
  };
  const urlWith = (base, p) => base.replace(/\/?$/, "/") + p;
  const noBase = () => new Error("brak MEDIA_BASE_URL (poza GitHub Actions ustaw go ręcznie)");
  // Wybiera pierwszy host, na którym WSZYSTKIE pliki posta są publicznie dostępne (GET pierwszego bajtu).
  const pickMedia = async (post, platform) => {
    const bases = mediaBases(post, platform);
    if (!bases.length) throw noBase();
    let last;
    for (const base of bases) {
      const url = (p) => urlWith(base, p);
      try {
        await probeMedia(post, url, fetchImpl);
        return url;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  const graph = makeGraph({ base: env.GRAPH_BASE || undefined, version: env.GRAPH_VERSION || undefined, token: env.META_ACCESS_TOKEN, fetchImpl });
  const targets = { instagram: env.IG_USER_ID, facebook: env.FB_PAGE_ID };
  // TikTok: przez Zernio (publicznie), jeśli jest ZERNIO_API_KEY; inaczej bezpośrednie API (prywatnie).
  // Token/konto pobieramy leniwie, tylko gdy jest należna rolka (każde odświeżenie rotuje refresh token).
  const viaZernio = zernioConfigured(env);
  const zernio = viaZernio ? makeZernio(env, fetchImpl) : null;
  let zernioAccount = null;
  const optionalAccounts = {}; // brak klucza = jeszcze nie sprawdzone, null = konto nie jest podłączone w Zernio
  let tiktokToken = null;

  log(`${live ? "NA ŻYWO" : "TRYB PRÓBNY (PUBLISH_LIVE≠true)"} · teraz ${new Date(now).toISOString()}`);
  if (live && !env.META_ACCESS_TOKEN) throw new Error("PUBLISH_LIVE=true, ale brak sekretu META_ACCESS_TOKEN");

  let failures = 0;
  let changed = false;
  for (const post of loadQueue(join(root, "queue"))) {
    const due = Date.parse(post.publish_at);
    for (const platform of post.platforms ?? []) {
      const key = `${post.id}:${platform}`;
      const entry = state[key] ?? { attempts: 0 };
      // "removed" = opublikowane, a potem usunięte z platformy (np. podmiana na wersję z dźwiękiem): nie wracamy do tego.
      if (["published", "skipped_stale", "failed", "removed"].includes(entry.status)) continue;
      if (due > now) continue;
      const set = (patch) => {
        state[key] = { ...entry, ...patch, updated_at: new Date(now).toISOString() };
        changed = true;
      };
      if (now - due > staleMs && !post.force) {
        log(`POMINIĘTE ${key}: termin minął ponad ${staleMs / HOUR} h temu (ustaw "force": true, żeby i tak opublikować)`);
        if (live) set({ status: "skipped_stale" });
        continue;
      }
      const waitUntil = rateLimitedUntil(entry, rateLimitBackoffMs, now);
      if (waitUntil > now) {
        log(`CZEKAM ${key}: ostatnia próba trafiła na limit zapytań Meta, kolejna po ${new Date(waitUntil).toISOString()}`);
        continue;
      }
      if (platform === "tiktok" && !viaZernio && !tiktokConfigured(env)) {
        log(`POMINIĘTE ${key}: TikTok nie skonfigurowany (brak ZERNIO_API_KEY ani sekretów TIKTOK_*)`);
        continue;
      }
      if (OPTIONAL[platform] && !viaZernio) {
        log(`POMINIĘTE ${key}: ${OPTIONAL[platform].name} idzie przez Zernio, a nie ma ZERNIO_API_KEY`);
        continue;
      }
      if (platform !== "tiktok" && !OPTIONAL[platform] && !targets[platform]) {
        log(`BŁĄD ${key}: brak ${platform === "instagram" ? "IG_USER_ID" : "FB_PAGE_ID"}`);
        failures++;
        continue;
      }
      const errors = validate(post, platform, root);
      if (errors.length) {
        log(`ODRZUCONE ${key}: ${errors.join("; ")}`);
        if (live) set({ status: "failed", error: errors.join("; ") });
        failures++;
        continue;
      }
      if (!live) {
        log(`[próba] opublikowałbym ${key} (${post.type}, ${post.media?.length ?? 0} plik.)`);
        continue;
      }
      try {
        if (platform === "tiktok" && viaZernio) {
          const mediaUrl = await pickMedia(post);
          zernioAccount ??= await findTikTokAccount(env, zernio);
          const result = await publishTikTokZernio(env, zernio, zernioAccount.id, post, mediaUrl, { attempt: entry.attempts + 1 });
          set({ status: "published", via: "zernio", id: result.id, zernio_status: result.status, permalink: result.permalink, attempts: entry.attempts + 1, published_at: new Date().toISOString() });
          log(`OPUBLIKOWANE ${key} przez Zernio → ${result.permalink ?? result.id} (${result.status})`);
          continue;
        }
        if (OPTIONAL[platform]) {
          const optional = OPTIONAL[platform];
          if (!(platform in optionalAccounts)) optionalAccounts[platform] = await optional.find(env, zernio);
          const account = optionalAccounts[platform];
          if (!account) {
            log(`POMINIĘTE ${key}: ${optional.missing}`);
            continue;
          }
          const mediaUrl = await pickMedia(post, platform);
          const result = await optional.publish(env, zernio, account.id, post, mediaUrl, { attempt: entry.attempts + 1 });
          set({ status: "published", via: "zernio", id: result.id, zernio_status: result.status, permalink: result.permalink, attempts: entry.attempts + 1, published_at: new Date().toISOString() });
          log(`OPUBLIKOWANE ${key} przez Zernio → ${result.permalink ?? result.id} (${result.status})`);
          continue;
        }
        if (platform === "tiktok") {
          tiktokToken ??= (await getTikTokAccess(env, { root, fetchImpl, now })).accessToken;
          const result = await publishTikTok(env, tiktokToken, post, { root, fetchImpl, waitOpts });
          set({ status: "published", id: result.id, tiktok_status: result.status, privacy: result.privacy, permalink: result.permalink, attempts: entry.attempts + 1, published_at: new Date().toISOString() });
          log(`OPUBLIKOWANE ${key} → ${result.permalink ?? result.id} (${result.status}, ${result.privacy})`);
          continue;
        }
        if (platform === "instagram" && entry.media_id) {
          // Poprzedni przebieg dostał id posta z media_publish i zapisał je trwale, ale nie dokończył wpisu.
          set({ status: "published", id: entry.media_id, attempts: entry.attempts + 1, reconciled_at: new Date(now).toISOString(), reconciled_from_checkpoint: true });
          log(`UZGODNIONE ${key}: id posta z zapisu kontrolnego poprzedniego przebiegu → ${entry.media_id}`);
          continue;
        }
        const mediaUrl = await pickMedia(post);
        // Trwały zapis kontrolny (dysk) przed media_publish i zaraz po nim; workflow wypycha stan także po błędzie.
        const checkpoint = (patch) => {
          const cur = state[key] ?? entry;
          const fresh = patch.creation_id && patch.creation_id !== cur.creation_id;
          state[key] = { ...cur, ...patch, ...(fresh ? { creation_at: new Date(now).toISOString() } : {}), updated_at: new Date(now).toISOString() };
          writeFileSync(statePath, JSON.stringify(sortKeys(state), null, 2) + "\n");
          changed = true;
        };
        const result =
          platform === "instagram"
            ? await publishInstagram(graph, targets.instagram, post, mediaUrl, { ...waitOpts, creationId: entry.creation_id, since: Date.parse(entry.creation_at), dueAt: due, checkpoint })
            : await publishFacebook(graph, targets.facebook, post, mediaUrl);
        if (result.reconciled) {
          // Poprzednia próba zgłosiła błąd, ale post jest na koncie: zapisujemy go, nie publikujemy ponownie.
          set({
            status: "published", id: result.id, permalink: result.permalink, attempts: entry.attempts + 1,
            reconciled_at: new Date(now).toISOString(), reconciled_container_status: result.containerStatus,
            ...(result.copies?.length > 1 ? { duplicates_on_platform: result.copies.slice(1).map((id) => ({ id })) } : {}),
          });
          log(`UZGODNIONE ${key}: post już jest na platformie mimo błędu poprzedniej próby → ${result.permalink ?? result.id}`);
          continue;
        }
        set({ status: "published", id: result.id, permalink: result.permalink, attempts: entry.attempts + 1, published_at: new Date().toISOString() });
        log(`OPUBLIKOWANE ${key} → ${result.permalink ?? result.id}`);
      } catch (e) {
        const attempts = entry.attempts + 1;
        // Historia prób z etapem: "probe" = błąd PRZED jakimkolwiek wywołaniem Graph/Zernio (nic nie mogło
        // wyjść), "publish" = po rozpoczęciu publikacji (post mógł częściowo lub w pełni powstać).
        // Sam brak "id" w stanie nie dowodzi, że nic nie wyszło.
        const code = e.info?.code;
        const regain = isRateLimited({ code, error: e.message }) ? regainMinutes(graph.usage().buc) : 0;
        const history = [...(entry.history ?? []), {
          at: new Date(now).toISOString(), stage: e.stage ?? "publish",
          ...(code !== undefined ? { code } : {}), ...(regain > 0 ? { regain_minutes: regain } : {}), error: e.message,
        }].slice(-5);
        // Kontener IG z tej próby zostaje w stanie (zapis kontrolny mógł go już utrwalić): następna próba
        // najpierw uzgadnia, czy post wyszedł. Id posta z zapisu kontrolnego też zostaje.
        const cur = state[key] ?? entry;
        const container = e.creationId
          ? { creation_id: e.creationId, creation_at: e.creationId === cur.creation_id ? cur.creation_at : new Date(now).toISOString() }
          : {};
        // needsReview: nie da się rozstrzygnąć, czy post wyszedł; ponowienie groziłoby duplikatem.
        const exhausted = attempts >= maxAttempts || e.info?.needsReview === true;
        set({ status: exhausted ? "failed" : "retry", attempts, error: e.message, history, ...container, ...(cur.media_id ? { media_id: cur.media_id } : {}) });
        log(`BŁĄD ${key} (próba ${attempts}/${maxAttempts}): ${e.message}`);
        failures++;
      }
    }
  }
  if (changed) writeFileSync(statePath, JSON.stringify(sortKeys(state), null, 2) + "\n");
  // Wyczerpane próby nie mogą zniknąć po jednym czerwonym przebiegu: dopóki pozycja z ostatnich
  // ALERT_WINDOW_HOURS (domyślnie 48) jest "failed" i nikt jej nie potwierdził, przebieg jest czerwony.
  const unresolved = findUnresolved(state, loadQueue(join(root, "queue")), now, Number(env.ALERT_WINDOW_HOURS ?? 48) * HOUR);
  for (const u of unresolved) log(`::error::NIEOPUBLIKOWANE ${u.key} (próby: ${u.attempts}): ${u.error ?? "brak opisu"}`);
  return { failures, changed, live, unresolved };
}

// Pozycje w stanie "failed" (próby wyczerpane), bez "acknowledged": true, których termin mieści się w oknie.
// "skipped_stale" i "removed" to świadome decyzje, więc nie alarmują. Wpis bez posta w kolejce jest pomijany.
export function findUnresolved(state, posts, now, windowMs) {
  const due = new Map(posts.map((p) => [p.id, Date.parse(p.publish_at)]));
  const out = [];
  for (const [key, entry] of Object.entries(state)) {
    if (entry?.status !== "failed" || entry.acknowledged === true) continue;
    const at = due.get(key.slice(0, key.lastIndexOf(":")));
    if (at === undefined || Number.isNaN(at) || now - at > windowMs) continue;
    out.push({ key, attempts: entry.attempts ?? 0, error: entry.error });
  }
  return out;
}

// Błędy limitu zapytań Meta (Graph API → Rate Limiting): 4 aplikacja, 17 użytkownik, 32 strona,
// 613 limit wywołań, 80000–80014 Business Use Case. Starsze wpisy historii nie mają kodu, stąd też tekst.
export function isRateLimited(h) {
  const code = Number(h?.code);
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return true;
  return /request limit reached|too many calls/i.test(h?.error ?? "");
}

const DAY_MINUTES = 24 * 60;

// RATE_LIMIT_BACKOFF_MINUTES: skończona liczba 0–1440 (0 = świadomie bez odstępu); wszystko inne
// (puste, tekst, NaN, ujemne, ponad dobę) = 60.
export function backoffMinutes(raw) {
  const n = Number(raw);
  return raw !== undefined && raw !== null && String(raw).trim() !== "" && Number.isFinite(n) && n >= 0 && n <= DAY_MINUTES ? n : 60;
}

// Najdłuższy estimated_time_to_regain_access (minuty) z nagłówka X-Business-Use-Case-Usage; 0 = brak danych.
export function regainMinutes(raw) {
  if (!raw) return 0;
  try {
    const rows = Object.values(JSON.parse(raw)).flat();
    const n = Math.max(0, ...rows.map((r) => Number(r?.estimated_time_to_regain_access) || 0));
    return Math.min(n, DAY_MINUTES);
  } catch {
    return 0;
  }
}

// Czas (ms), przed którym nie ponawiamy pozycji "retry", bo ostatnia próba trafiła na limit. 0 = bez czekania.
// Brak lub zły czas ostatniej próby przy błędzie limitu: czekamy pełne okno od teraz (fail-closed), nie zero.
export function rateLimitedUntil(entry, backoffMs, now = Date.now()) {
  if (entry?.status !== "retry") return 0;
  const last = entry.history?.at(-1);
  if (!last || !isRateLimited(last)) return 0;
  const wait = Math.max(backoffMs, (Number(last.regain_minutes) || 0) * 60 * 1000);
  const at = Date.parse(last.at);
  return Number.isFinite(at) ? at + wait : now + wait;
}

// Meta i Zernio pobierają pliki same, więc najpierw sprawdzamy, czy adres publiczny działa
// (GET pierwszego bajtu: nie każdy CDN obsługuje HEAD).
async function probeMedia(post, mediaUrl, fetchImpl) {
  for (const m of [...(post.media ?? []), ...(post.cover ? [post.cover] : [])]) {
    const probe = await fetchImpl(mediaUrl(m), { headers: { range: "bytes=0-0" } });
    await probe.body?.cancel();
    if (!probe.ok) throw Object.assign(new Error(`plik ${m} niedostępny pod publicznym adresem (${probe.status})`), { stage: "probe" });
  }
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    // Próba nigdy nie kończy się błędem (cron co 10 minut nie zasypie Cię e-mailami przed
    // konfiguracją); błędy w kolejce łapie validate-queue.mjs przy każdym pushu.
    .then(({ failures, live, unresolved }) => process.exit(live && (failures || unresolved.length) ? 1 : 0))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
