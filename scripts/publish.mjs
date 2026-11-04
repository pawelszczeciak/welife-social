// Publikuje posty z queue/, których czas minął, na Instagram, stronę FB i TikTok.
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

const HOUR = 3600 * 1000;

export async function run(env = process.env, { root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), log = console.log, fetchImpl = fetch, waitOpts } = {}) {
  const live = env.PUBLISH_LIVE === "true";
  const now = env.NOW ? Date.parse(env.NOW) : Date.now();
  const staleMs = Number(env.STALE_HOURS ?? 24) * HOUR;
  const maxAttempts = Number(env.MAX_ATTEMPTS ?? 3);
  const statePath = join(root, "state", "published.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  // Puste zmienne repo przychodzą z Actions jako "", więc || zamiast ??.
  const base =
    env.MEDIA_BASE_URL ||
    (env.GITHUB_REPOSITORY && env.GITHUB_SHA ? `https://cdn.jsdelivr.net/gh/${env.GITHUB_REPOSITORY}@${env.GITHUB_SHA}/` : null);
  const mediaUrl = (p) => {
    if (!base) throw new Error("brak MEDIA_BASE_URL (poza GitHub Actions ustaw go ręcznie)");
    return base.replace(/\/?$/, "/") + p;
  };
  const graph = makeGraph({ base: env.GRAPH_BASE || undefined, version: env.GRAPH_VERSION || undefined, token: env.META_ACCESS_TOKEN, fetchImpl });
  const targets = { instagram: env.IG_USER_ID, facebook: env.FB_PAGE_ID };
  // Token TikToka pobieramy leniwie, tylko gdy jest należna rolka (każde odświeżenie rotuje refresh token).
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
      if (["published", "skipped_stale", "failed"].includes(entry.status)) continue;
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
      if (platform === "tiktok" && !tiktokConfigured(env)) {
        log(`POMINIĘTE ${key}: TikTok nie skonfigurowany (brak sekretów TIKTOK_*)`);
        continue;
      }
      if (platform !== "tiktok" && !targets[platform]) {
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
        if (platform === "tiktok") {
          tiktokToken ??= (await getTikTokAccess(env, { root, fetchImpl, now })).accessToken;
          const result = await publishTikTok(env, tiktokToken, post, { root, fetchImpl, waitOpts });
          set({ status: "published", id: result.id, tiktok_status: result.status, privacy: result.privacy, permalink: result.permalink, attempts: entry.attempts + 1, published_at: new Date().toISOString() });
          log(`OPUBLIKOWANE ${key} → ${result.permalink ?? result.id} (${result.status}, ${result.privacy})`);
          continue;
        }
        for (const m of [...(post.media ?? []), ...(post.cover ? [post.cover] : [])]) {
          // Meta pobiera pliki sama, więc najpierw sprawdzamy, czy adres publiczny działa
          // (GET pierwszego bajtu: nie każdy CDN obsługuje HEAD).
          const probe = await fetchImpl(mediaUrl(m), { headers: { range: "bytes=0-0" } });
          await probe.body?.cancel();
          if (!probe.ok) throw new Error(`plik ${m} niedostępny pod publicznym adresem (${probe.status})`);
        }
        const result =
          platform === "instagram"
            ? await publishInstagram(graph, targets.instagram, post, mediaUrl, waitOpts)
            : await publishFacebook(graph, targets.facebook, post, mediaUrl);
        set({ status: "published", id: result.id, permalink: result.permalink, attempts: entry.attempts + 1, published_at: new Date().toISOString() });
        log(`OPUBLIKOWANE ${key} → ${result.permalink ?? result.id}`);
      } catch (e) {
        const attempts = entry.attempts + 1;
        set({ status: attempts >= maxAttempts ? "failed" : "retry", attempts, error: e.message });
        log(`BŁĄD ${key} (próba ${attempts}/${maxAttempts}): ${e.message}`);
        failures++;
      }
    }
  }
  if (changed) writeFileSync(statePath, JSON.stringify(sortKeys(state), null, 2) + "\n");
  return { failures, changed, live };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    // Próba nigdy nie kończy się błędem (cron co 10 minut nie zasypie Cię e-mailami przed
    // konfiguracją); błędy w kolejce łapie validate-queue.mjs przy każdym pushu.
    .then(({ failures, live }) => process.exit(live && failures ? 1 : 0))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
