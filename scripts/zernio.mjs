// TikTok, YouTube Shorts i Pinterest przez Zernio (dawniej Late, https://docs.zernio.com): zatwierdzony partner
// TikToka, więc filmy wychodzą publicznie. YouTube i Pinterest działają, gdy w Zernio jest podłączone konto. Ma pierwszeństwo przed bezpośrednim API TikToka
// (scripts/tiktok.mjs), które bez audytu TikToka publikuje tylko prywatnie.
//
// Klucz ZERNIO_API_KEY nigdy nie trafia do logów, stanu ani komunikatów błędów.
import { createHash } from "node:crypto";
import { textFor, youtubeTitle, pinterestTitle, pinterestMedia, pinterestLink } from "./lib.mjs";

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

// Opcjonalne konto w Zernio (YouTube, Pinterest): z sekretu albo jedyne podłączone konto tej platformy.
// Brak konta to nie błąd (zwraca null): platforma jest wtedy pomijana.
async function findOptionalAccount(env, call, platform, secretName, label) {
  if (env[secretName]) return { id: env[secretName], name: null };
  const res = await call("GET", "/accounts");
  if (res.status !== 200) throw apiError("lista kont", res);
  const all = res.json.accounts ?? res.json.data ?? [];
  const accounts = all.filter((a) => String(a.platform ?? "").toLowerCase() === platform);
  if (accounts.length === 0) return null;
  if (accounts.length > 1) throw new ZernioError(`w Zernio jest ${accounts.length} ${label}: ustaw sekret ${secretName}`);
  const a = accounts[0];
  return { id: a._id ?? a.id, name: a.displayName ?? a.username ?? a.name ?? null };
}

export const findYouTubeAccount = (env, call) => findOptionalAccount(env, call, "youtube", "ZERNIO_YOUTUBE_ACCOUNT_ID", "kanałów YouTube");
export const findPinterestAccount = (env, call) => findOptionalAccount(env, call, "pinterest", "ZERNIO_PINTEREST_ACCOUNT_ID", "kont Pinterest");

// Tablica na piny: PINTEREST_BOARD_ID, albo tablica o nazwie PINTEREST_BOARD_NAME (domyślnie „Plan posiłków”),
// a gdy takiej nie ma, automat zakłada ją raz (publiczną). Bez boardId Pinterest wybiera przypadkową tablicę.
export const PINTEREST_BOARD = { name: "Plan posiłków", description: "Plan posiłków na tydzień, lista zakupów i domowe zapasy. WE.LIFE, darmowa wersja beta (testowa): welife.world" };
const boards = new Map();
export async function pinterestBoard(env, call, accountId) {
  if (env.PINTEREST_BOARD_ID) return { id: env.PINTEREST_BOARD_ID, name: null, created: false };
  if (boards.has(accountId)) return boards.get(accountId);
  const path = `/accounts/${encodeURIComponent(accountId)}/pinterest-boards`;
  const res = await call("GET", path);
  if (res.status !== 200) throw apiError("tablice Pinterest", res);
  const want = (env.PINTEREST_BOARD_NAME || PINTEREST_BOARD.name).trim().toLowerCase();
  const found = (res.json.boards ?? []).find((b) => String(b.name ?? "").trim().toLowerCase() === want);
  let board;
  if (found) board = { id: found.id, name: found.name, created: false };
  else {
    const made = await call("POST", path, { body: { name: env.PINTEREST_BOARD_NAME || PINTEREST_BOARD.name, description: PINTEREST_BOARD.description, privacy: "PUBLIC" } });
    if (![200, 201].includes(made.status) || !made.json.board?.id) throw apiError("założenie tablicy Pinterest", made);
    board = { id: made.json.board.id, name: made.json.board.name, created: true };
  }
  boards.set(accountId, board);
  return board;
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

// Pinterest: jeden obraz albo jeden film na pin, z klikalnym linkiem do welife.world (z UTM) i tablicą.
// Karuzela idzie jako jeden slajd (pinterest.media albo pierwszy). Obrazy AI zgłoszone polem isAiGenerated.
export async function publishPinterestZernio(env, call, accountId, post, mediaUrl, { attempt = 1 } = {}) {
  const board = await pinterestBoard(env, call, accountId);
  const video = post.type === "reel";
  const res = await call("POST", "/posts", {
    headers: { "Idempotency-Key": idempotencyKey(post.id, attempt, "pinterest") },
    body: {
      content: textFor(post, "pinterest"),
      mediaItems: [video ? { type: "video", url: mediaUrl(post.media[0]) } : { type: "image", url: mediaUrl(pinterestMedia(post)) }],
      platforms: [{
        platform: "pinterest",
        accountId,
        platformSpecificData: {
          boardId: board.id,
          title: pinterestTitle(post),
          link: pinterestLink(post),
          isAiGenerated: Boolean(post.ai_imagery),
          ...(video && post.cover ? { coverImageUrl: mediaUrl(post.cover) } : {}),
        },
      }],
      publishNow: true,
    },
  });
  return readResult(res, "pinterest", "Pinterest");
}
