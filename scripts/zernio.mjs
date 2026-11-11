// TikTok i YouTube Shorts przez Zernio (dawniej Late, https://docs.zernio.com): zatwierdzony partner TikToka,
// więc filmy wychodzą publicznie. YouTube działa, gdy w Zernio jest podłączony kanał. Ma pierwszeństwo przed bezpośrednim API TikToka
// (scripts/tiktok.mjs), które bez audytu TikToka publikuje tylko prywatnie.
//
// Klucz ZERNIO_API_KEY nigdy nie trafia do logów, stanu ani komunikatów błędów.
import { createHash } from "node:crypto";
import { textFor, youtubeTitle } from "./lib.mjs";

export const ZERNIO_BASE = "https://zernio.com/api/v1";

export class ZernioError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.info = info;
  }
}

export const zernioConfigured = (env) => Boolean(env.ZERNIO_API_KEY);

export function makeZernio(env, fetchImpl = fetch) {
  const base = (env.ZERNIO_BASE || ZERNIO_BASE).replace(/\/$/, "");
  return async function call(method, path, { body, headers = {} } = {}) {
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        authorization: `Bearer ${env.ZERNIO_API_KEY}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

function apiError(what, { status, json }) {
  const msg = json.error?.message ?? json.error ?? json.message ?? "";
  return new ZernioError(`Zernio ${what}: HTTP ${status}${msg ? ` ${typeof msg === "string" ? msg : JSON.stringify(msg)}` : ""}`, { status });
}

// Konto TikTok: z sekretu ZERNIO_TIKTOK_ACCOUNT_ID albo jedyne podłączone konto TikTok.
export async function findTikTokAccount(env, call) {
  if (env.ZERNIO_TIKTOK_ACCOUNT_ID) return { id: env.ZERNIO_TIKTOK_ACCOUNT_ID, name: null };
  // Bez filtrów w zapytaniu: dokumentacja Zernio pokazuje samo GET /v1/accounts, a nieznany
  // filtr (np. status) potrafi zwrócić pustą listę mimo podłączonego konta.
  const res = await call("GET", "/accounts");
  if (res.status !== 200) throw apiError("lista kont", res);
  const all = res.json.accounts ?? res.json.data ?? [];
  const accounts = all.filter((a) => String(a.platform ?? "").toLowerCase() === "tiktok");
  if (accounts.length === 0) {
    const seen = [...new Set(all.map((a) => String(a.platform ?? "?").toLowerCase()))];
    throw new ZernioError(`w Zernio nie ma podłączonego konta TikTok (widoczne konta: ${seen.length ? seen.join(", ") : "brak"})`);
  }
  if (accounts.length > 1) {
    throw new ZernioError(`w Zernio jest ${accounts.length} kont TikTok: ustaw sekret ZERNIO_TIKTOK_ACCOUNT_ID`);
  }
  const a = accounts[0];
  return { id: a._id, name: a.username ?? a.displayName ?? a.name ?? null };
}

export async function tiktokCreatorInfo(call, accountId) {
  const res = await call("GET", `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info?mediaType=video`);
  if (res.status !== 200) throw apiError("creator-info", res);
  return res.json;
}

// Kanał YouTube podłączony w Zernio: z sekretu ZERNIO_YOUTUBE_ACCOUNT_ID albo jedyny podłączony kanał.
// Brak kanału to nie błąd (zwraca null): YouTube jest opcjonalny i rolki są wtedy pomijane.
export async function findYouTubeAccount(env, call) {
  if (env.ZERNIO_YOUTUBE_ACCOUNT_ID) return { id: env.ZERNIO_YOUTUBE_ACCOUNT_ID, name: null };
  const res = await call("GET", "/accounts");
  if (res.status !== 200) throw apiError("lista kont", res);
  const all = res.json.accounts ?? res.json.data ?? [];
  const accounts = all.filter((a) => String(a.platform ?? "").toLowerCase() === "youtube");
  if (accounts.length === 0) return null;
  if (accounts.length > 1) {
    throw new ZernioError(`w Zernio jest ${accounts.length} kanałów YouTube: ustaw sekret ZERNIO_YOUTUBE_ACCOUNT_ID`);
  }
  const a = accounts[0];
  return { id: a._id ?? a.id, name: a.displayName ?? a.username ?? a.name ?? null };
}

// Ten sam klucz dla tej samej próby: ponowienie po przerwanym połączeniu nie zrobi duplikatu,
// a kolejna próba (inny numer) naprawdę publikuje od nowa.
function idempotencyKey(postId, attempt, platform = "tiktok") {
  const h = createHash("sha256").update(`${postId}:${platform}:${attempt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function publishTikTokZernio(env, call, accountId, post, mediaUrl, { attempt = 1 } = {}) {
  const settings = {
    privacy_level: env.TIKTOK_PRIVACY || "PUBLIC_TO_EVERYONE",
    allow_comment: true,
    allow_duet: true,
    allow_stitch: true,
    content_preview_confirmed: true,
    express_consent_given: true,
    // Promocja własnej marki (WE.LIFE), nie płatna współpraca.
    commercial_content_type: "brand_organic",
    video_made_with_ai: Boolean(post.ai_imagery),
  };
  if (post.cover) settings.video_cover_image_url = mediaUrl(post.cover);
  const res = await call("POST", "/posts", {
    headers: { "Idempotency-Key": idempotencyKey(post.id, attempt) },
    body: {
      content: textFor(post, "tiktok"),
      mediaItems: [{ type: "video", url: mediaUrl(post.media[0]) }],
      platforms: [{ platform: "tiktok", accountId }],
      tiktokSettings: settings,
      publishNow: true,
    },
  });
  return readResult(res, "tiktok", "TikTok");
}

// Wspólne odczytanie odpowiedzi POST /posts dla TikToka i YouTube.
function readResult(res, platform, label) {
  // 409: ten sam tekst w ciągu 24 h, więc post już istnieje; nie publikujemy drugi raz.
  if (res.status === 409 && res.json.details?.existingPostId) {
    return { id: res.json.details.existingPostId, status: "duplicate", permalink: null };
  }
  if (![200, 201, 207].includes(res.status)) throw apiError("publikacja", res);
  const p = res.json.post ?? {};
  const entry = (p.platforms ?? []).find((x) => x.platform === platform) ?? {};
  const failed = p.status === "failed" || entry.status === "failed" || (p.status === "partial" && entry.status !== "published");
  if (failed) {
    const reason = (res.json.platformResults ?? []).find((r) => r.platform === platform)?.error ?? res.json.error ?? p.status;
    throw new ZernioError(`Zernio: ${label} nie opublikował (${typeof reason === "string" ? reason : JSON.stringify(reason)})`, { status: res.status });
  }
  // "scheduled" po 207 = przejściowy błąd, Zernio ponawia sam, więc my nie ponawiamy.
  return { id: p._id ?? null, status: p.status ?? "unknown", permalink: entry.platformPostUrl ?? null };
}

// YouTube Shorts: ta sama rolka (pionowa, do 3 minut, więc YouTube sam uznaje ją za Short).
// Tytuł = pierwsza linia opisu (do 100 znaków), opis z linkiem do welife.world, okładka jako miniatura,
// obrazy AI zgłoszone polem containsSyntheticMedia, film nie jest „dla dzieci”.
export async function publishYouTubeZernio(env, call, accountId, post, mediaUrl, { attempt = 1 } = {}) {
  const res = await call("POST", "/posts", {
    headers: { "Idempotency-Key": idempotencyKey(post.id, attempt, "youtube") },
    body: {
      content: textFor(post, "youtube"),
      mediaItems: [{ type: "video", url: mediaUrl(post.media[0]), ...(post.cover ? { thumbnail: mediaUrl(post.cover) } : {}) }],
      platforms: [{
        platform: "youtube",
        accountId,
        platformSpecificData: {
          title: youtubeTitle(post),
          visibility: env.YOUTUBE_VISIBILITY || "public",
          madeForKids: false,
          containsSyntheticMedia: Boolean(post.ai_imagery),
          categoryId: env.YOUTUBE_CATEGORY_ID || "26", // Howto & Style
        },
      }],
      publishNow: true,
    },
  });
  return readResult(res, "youtube", "YouTube");
}
