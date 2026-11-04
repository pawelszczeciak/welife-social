// TikTok przez Zernio (dawniej Late, https://docs.zernio.com): zatwierdzony partner TikToka,
// więc filmy wychodzą publicznie. Ma pierwszeństwo przed bezpośrednim API TikToka
// (scripts/tiktok.mjs), które bez audytu TikToka publikuje tylko prywatnie.
//
// Klucz ZERNIO_API_KEY nigdy nie trafia do logów, stanu ani komunikatów błędów.
import { createHash } from "node:crypto";
import { textFor } from "./lib.mjs";

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

// Ten sam klucz dla tej samej próby: ponowienie po przerwanym połączeniu nie zrobi duplikatu,
// a kolejna próba (inny numer) naprawdę publikuje od nowa.
function idempotencyKey(postId, attempt) {
  const h = createHash("sha256").update(`${postId}:tiktok:${attempt}`).digest("hex");
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
  // 409: ten sam tekst w ciągu 24 h, więc post już istnieje; nie publikujemy drugi raz.
  if (res.status === 409 && res.json.details?.existingPostId) {
    return { id: res.json.details.existingPostId, status: "duplicate", permalink: null };
  }
  if (![200, 201, 207].includes(res.status)) throw apiError("publikacja", res);
  const p = res.json.post ?? {};
  const entry = (p.platforms ?? []).find((x) => x.platform === "tiktok") ?? {};
  const failed = p.status === "failed" || entry.status === "failed" || (p.status === "partial" && entry.status !== "published");
  if (failed) {
    const reason = (res.json.platformResults ?? []).find((r) => r.platform === "tiktok")?.error ?? res.json.error ?? p.status;
    throw new ZernioError(`Zernio: TikTok nie opublikował (${typeof reason === "string" ? reason : JSON.stringify(reason)})`, { status: res.status });
  }
  // "scheduled" po 207 = przejściowy błąd, Zernio ponawia sam, więc my nie ponawiamy.
  return { id: p._id ?? null, status: p.status ?? "unknown", permalink: entry.platformPostUrl ?? null };
}
