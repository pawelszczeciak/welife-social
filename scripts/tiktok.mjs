// TikTok: Content Posting API (Direct Post, FILE_UPLOAD) dla rolek z kolejki.
//
// Tokeny: access token żyje 2 h, refresh token 180 dni i ROTUJE przy każdym odświeżeniu
// (poprzedni przestaje działać). Dlatego nowy refresh token zapisujemy zaszyfrowany
// (AES-256-GCM, klucz w sekrecie TIKTOK_VAULT_KEY) w vault/tiktok.json.enc i commitujemy
// razem ze stanem. Sekret TIKTOK_REFRESH_TOKEN służy tylko do pierwszego uruchomienia.
// Tokeny nigdy nie trafiają do logów, stanu ani komunikatów błędów.
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const TIKTOK_BASE = "https://open.tiktokapis.com";
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TikTokError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.info = info;
  }
}

export function tiktokConfigured(env) {
  return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && (env.TIKTOK_REFRESH_TOKEN || env.TIKTOK_VAULT_KEY));
}

export const vaultPath = (root) => join(root, "vault", "tiktok.json.enc");

function vaultKey(env) {
  const key = Buffer.from(env.TIKTOK_VAULT_KEY ?? "", "base64");
  if (key.length !== 32) {
    throw new TikTokError("brak poprawnego sekretu TIKTOK_VAULT_KEY (32 bajty w base64): wygeneruj go skryptem scripts/tiktok-auth.mjs");
  }
  return key;
}

export function readVault(root, env) {
  const path = vaultPath(root);
  if (!existsSync(path)) return null;
  const { iv, tag, data } = JSON.parse(readFileSync(path, "utf8"));
  const d = createDecipheriv("aes-256-gcm", vaultKey(env), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8"));
  } catch {
    throw new TikTokError("nie da się odszyfrować vault/tiktok.json.enc: TIKTOK_VAULT_KEY nie pasuje do pliku");
  }
}

export function writeVault(root, env, payload) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", vaultKey(env), iv);
  const data = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  const path = vaultPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }) + "\n");
}

// Odcisk sekretu TIKTOK_REFRESH_TOKEN: gdy właściciel autoryzuje aplikację ponownie i podmieni
// sekret, odcisk się zmienia i sejf jest pomijany (bez ręcznego kasowania pliku).
const fingerprint = (token) => createHash("sha256").update(String(token ?? "")).digest("hex").slice(0, 16);

// Jeden token na przebieg: odświeżamy tylko, gdy zapisany access token wygasa w ciągu 10 min.
// Klucz sejfu sprawdzamy PRZED odświeżeniem, bo bez niego nowy refresh token by przepadł.
export async function getTikTokAccess(env, { root, fetchImpl = fetch, now = Date.now() } = {}) {
  vaultKey(env);
  const base = env.TIKTOK_BASE || TIKTOK_BASE;
  let saved = readVault(root, env);
  if (saved && env.TIKTOK_REFRESH_TOKEN && saved.seed_fp !== fingerprint(env.TIKTOK_REFRESH_TOKEN)) saved = null;
  if (saved?.access_token && saved.access_expires_at - now > 10 * 60 * 1000) {
    return { accessToken: saved.access_token, openId: saved.open_id, refreshed: false };
  }
  const refreshToken = saved?.refresh_token ?? env.TIKTOK_REFRESH_TOKEN;
  if (!refreshToken) throw new TikTokError("brak refresh tokenu TikTok: uruchom scripts/tiktok-auth.mjs i ustaw sekret TIKTOK_REFRESH_TOKEN");
  const res = await fetchImpl(`${base}/v2/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || !json.access_token) {
    throw new TikTokError(
      `TikTok: odświeżenie tokenu nie powiodło się (${json.error ?? res.status}). ` +
        "Jeśli refresh token wygasł albo został już zużyty, uruchom ponownie scripts/tiktok-auth.mjs i podmień sekret TIKTOK_REFRESH_TOKEN.",
      { status: res.status, code: json.error, log_id: json.log_id },
    );
  }
  writeVault(root, env, {
    refresh_token: json.refresh_token,
    access_token: json.access_token,
    access_expires_at: now + Number(json.expires_in ?? 0) * 1000,
    refresh_expires_at: now + Number(json.refresh_expires_in ?? 0) * 1000,
    open_id: json.open_id,
    scope: json.scope,
    seed_fp: saved?.seed_fp ?? fingerprint(env.TIKTOK_REFRESH_TOKEN),
  });
  return { accessToken: json.access_token, openId: json.open_id, refreshed: true };
}

async function api(env, token, path, body, fetchImpl) {
  const base = env.TIKTOK_BASE || TIKTOK_BASE;
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  const code = json.error?.code;
  if (!res.ok || (code && code !== "ok")) {
    throw new TikTokError(`TikTok ${path}: ${code ?? res.status}${json.error?.message ? ` (${json.error.message})` : ""}`, {
      status: res.status, code, log_id: json.error?.log_id ?? json.error?.logid,
    });
  }
  return json.data ?? {};
}

export const creatorInfo = (env, token, fetchImpl = fetch) => api(env, token, "/v2/post/publish/creator_info/query/", {}, fetchImpl);

// Podział pliku wg zasad TikToka: plik < 5 MB w jednym kawałku; inaczej kawałki 5–64 MB,
// liczba kawałków = floor(rozmiar / kawałek), ostatni zabiera resztę (do 128 MB).
export function chunkPlan(size, preferred = 10 * MB) {
  if (size < 5 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = Math.min(Math.max(preferred, 5 * MB), 64 * MB);
  return { chunkSize, count: Math.max(1, Math.floor(size / chunkSize)) };
}

function readRange(path, start, length) {
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf;
}

export function tiktokCaption(post) {
  return post.tiktok?.caption ?? post.caption ?? "";
}

export async function publishTikTok(env, token, post, { root, fetchImpl = fetch, waitOpts = {} } = {}) {
  const privacy = env.TIKTOK_PRIVACY || "SELF_ONLY";
  const info = await creatorInfo(env, token, fetchImpl);
  const options = info.privacy_level_options ?? [];
  if (!options.includes(privacy)) {
    throw new TikTokError(`TikTok nie pozwala teraz na prywatność ${privacy}; dostępne: ${options.join(", ") || "(brak)"}`);
  }
  const file = join(root, post.media[0]);
  const size = statSync(file).size;
  const { chunkSize, count } = chunkPlan(size, waitOpts.chunkSize);
  const init = await api(env, token, "/v2/post/publish/video/init/", {
    post_info: {
      title: tiktokCaption(post),
      privacy_level: privacy,
      disable_comment: Boolean(info.comment_disabled),
      disable_duet: Boolean(info.duet_disabled),
      disable_stitch: Boolean(info.stitch_disabled),
      // Promujemy własną markę (WE.LIFE), to nie jest płatna współpraca.
      brand_content_toggle: false,
      brand_organic_toggle: true,
      // Etykieta TikToka „treści wygenerowane przez AI”, gdy w filmie są ilustracje AI.
      is_aigc: Boolean(post.ai_imagery),
    },
    source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count },
  }, fetchImpl);
  if (!init.upload_url || !init.publish_id) throw new TikTokError("TikTok: brak upload_url lub publish_id w odpowiedzi");

  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    const body = readRange(file, start, end - start + 1);
    const res = await fetchImpl(init.upload_url, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(body.length), "content-range": `bytes ${start}-${end}/${size}` },
      body,
    });
    const last = i === count - 1;
    if (!(last ? [200, 201].includes(res.status) : res.status === 206)) {
      throw new TikTokError(`TikTok: wysyłanie kawałka ${i + 1}/${count} zwróciło ${res.status}`);
    }
  }

  const until = Date.now() + (waitOpts.timeoutMs ?? 10 * 60 * 1000);
  for (;;) {
    const s = await api(env, token, "/v2/post/publish/status/fetch/", { publish_id: init.publish_id }, fetchImpl);
    if (s.status === "PUBLISH_COMPLETE" || s.status === "SEND_TO_USER_INBOX") {
      const postId = s.publicaly_available_post_id?.[0];
      return {
        id: init.publish_id,
        status: s.status,
        privacy,
        permalink: postId && info.creator_username ? `https://www.tiktok.com/@${info.creator_username}/video/${postId}` : undefined,
      };
    }
    if (s.status === "FAILED") throw new TikTokError(`TikTok: publikacja nie powiodła się (${s.fail_reason ?? "brak powodu"})`);
    if (Date.now() > until) throw new TikTokError("TikTok: przekroczony czas przetwarzania filmu");
    await sleep(waitOpts.intervalMs ?? 5000);
  }
}
