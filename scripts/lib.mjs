// Wspólne funkcje automatu: kolejka, walidacja, klient Graph API, publikacja IG i FB.
// TikTok ma własny moduł: scripts/tiktok.mjs.
// Bez zależności: Node 22+ (fetch, node:test).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const PLATFORMS = ["instagram", "facebook", "tiktok"];
export const TYPES = ["reel", "carousel", "image", "text"];
const IG_HASHTAG_LIMIT = 5;

export function loadQueue(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at));
}

export function textFor(post, platform) {
  if (platform === "facebook" && post.facebook?.message) return post.facebook.message;
  if (platform === "tiktok" && post.tiktok?.caption) return post.tiktok.caption;
  return post.caption ?? "";
}

// Zwraca listę powodów, dla których posta NIE wolno opublikować na danej platformie.
export function validate(post, platform, root) {
  const errors = [];
  const text = textFor(post, platform);
  if (!post.id) errors.push("brak id");
  if (Number.isNaN(Date.parse(post.publish_at))) errors.push("publish_at nie jest datą ISO z przesunięciem");
  if (!TYPES.includes(post.type)) errors.push(`nieznany typ: ${post.type}`);
  if (platform === "instagram" && post.type === "text") errors.push("Instagram nie przyjmuje postów bez zdjęcia/filmu");
  if (platform === "tiktok" && post.type !== "reel") errors.push("TikTok w tym automacie przyjmuje tylko rolki (type: reel)");
  if (!text.trim()) errors.push("pusty tekst");
  if (text.includes("{{")) errors.push("tekst zawiera niewypełnione pole {{…}}");
  // Zasada właściciela: każdy materiał mówi, że to wersja beta (testowa).
  if (!/beta/i.test(text)) errors.push("tekst nie mówi, że WE.LIFE to wersja beta");
  if (post.ai_imagery && !/\bAI\b/.test(text)) errors.push("obrazy AI bez informacji „AI” w tekście");
  if (platform === "instagram" || platform === "tiktok") {
    const tags = text.match(/(?:^|\s)#\w+/gu) ?? [];
    if (tags.length > IG_HASHTAG_LIMIT) errors.push(`${tags.length} hashtagów, limit to ${IG_HASHTAG_LIMIT}`);
    if (text.length > 2200) errors.push("opis dłuższy niż 2200 znaków");
  }
  const media = post.media ?? [];
  if (post.type !== "text" && media.length === 0) errors.push("brak plików media");
  if (post.type === "carousel" && (media.length < 2 || media.length > 10)) errors.push("karuzela: 2–10 plików");
  if (platform === "instagram" && ["carousel", "image"].includes(post.type) && media.some((m) => !/\.jpe?g$/i.test(m))) {
    errors.push("Instagram API przyjmuje zdjęcia tylko w JPEG");
  }
  if (post.type === "reel" && !/\.mp4$/i.test(media[0] ?? "")) errors.push("rolka wymaga pliku .mp4");
  for (const m of [...media, ...(post.cover ? [post.cover] : [])]) {
    if (root && !existsSync(join(root, m))) errors.push(`brak pliku ${m}`);
  }
  // Zasada właściciela: każda rolka ma dźwięk. Po publikacji nie da się go już dodać.
  if (post.type === "reel" && root && /\.mp4$/i.test(media[0] ?? "") && existsSync(join(root, media[0]))) {
    const kbps = audioKbps(join(root, media[0]));
    if (kbps === null) errors.push(`rolka ${media[0]} nie ma ścieżki dźwiękowej`);
    else if (kbps < MIN_AUDIO_KBPS) errors.push(`rolka ${media[0]} jest cicha (dźwięk ${kbps.toFixed(1)} kb/s)`);
  }
  return errors;
}

// Cisza zakodowana w AAC zajmuje ~2 kb/s, podkład muzyczny ~160 kb/s (ffmpeg, -b:a 160k).
export const MIN_AUDIO_KBPS = 16;

// Średni bitrate ścieżki dźwiękowej z tabel MP4 (hdlr „soun”, mdhd, stsz), bez ffmpeg.
// null = brak ścieżki dźwiękowej albo plik, którego nie da się odczytać jako MP4.
export function audioKbps(file) {
  const buf = readFileSync(file);
  const boxes = (start, end) => {
    const out = [];
    for (let at = start; at + 8 <= end; ) {
      let size = buf.readUInt32BE(at);
      const type = buf.toString("latin1", at + 4, at + 8);
      let head = 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(at + 8));
        head = 16;
      } else if (size === 0) size = end - at;
      if (size < head || at + size > end) break;
      out.push({ type, start: at + head, end: at + size });
      at += size;
    }
    return out;
  };
  const child = (box, type) => box && boxes(box.start, box.end).find((b) => b.type === type);
  const moov = boxes(0, buf.length).find((b) => b.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(trak, "mdia");
    const hdlr = child(mdia, "hdlr");
    if (!hdlr || buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "soun") continue;
    const mdhd = child(mdia, "mdhd");
    const stsz = child(child(child(mdia, "minf"), "stbl"), "stsz");
    if (!mdhd || !stsz) return null;
    const v1 = buf[mdhd.start] === 1;
    const timescale = buf.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
    const duration = v1 ? Number(buf.readBigUInt64BE(mdhd.start + 24)) : buf.readUInt32BE(mdhd.start + 16);
    const fixed = buf.readUInt32BE(stsz.start + 4);
    const count = buf.readUInt32BE(stsz.start + 8);
    let bytes = fixed * count;
    if (fixed === 0) for (let i = 0; i < count; i++) bytes += buf.readUInt32BE(stsz.start + 12 + 4 * i);
    const secs = duration / timescale;
    return secs > 0 ? (bytes * 8) / secs / 1000 : null;
  }
  return null;
}

export class GraphError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.info = info;
  }
}

// Klient Graph API. Token nigdy nie trafia do logów ani do komunikatów błędów.
export function makeGraph({ base = "https://graph.facebook.com", version = "v23.0", token, fetchImpl = fetch }) {
  const url = (path) => `${base.replace(/\/$/, "")}/${version}/${path.replace(/^\//, "")}`;
  async function call(method, path, params = {}, accessToken = token) {
    const body = new URLSearchParams({ ...stringify(params), access_token: accessToken });
    const res =
      method === "GET" || method === "DELETE"
        ? await fetchImpl(`${url(path)}?${body}`, { method })
        : await fetchImpl(url(path), { method, body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      throw new GraphError(`Graph API ${method} ${path}: ${e.message ?? res.status}`, {
        status: res.status, code: e.code, subcode: e.error_subcode, trace: e.fbtrace_id,
      });
    }
    return json;
  }
  return {
    get: (p, q, t) => call("GET", p, q, t),
    post: (p, q, t) => call("POST", p, q, t),
    del: (p, q, t) => call("DELETE", p, q, t),
  };
}

function stringify(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Instagram przetwarza film asynchronicznie; publikować wolno dopiero po FINISHED.
export async function waitForContainer(graph, id, { intervalMs = 5000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { status_code: code, status } = await graph.get(id, { fields: "status_code,status" });
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new GraphError(`kontener ${id}: ${code} ${status ?? ""}`.trim());
    if (Date.now() > until) throw new GraphError(`kontener ${id}: przekroczony czas przetwarzania`);
    await sleep(intervalMs);
  }
}

export async function publishInstagram(graph, igUserId, post, mediaUrl, opts = {}) {
  const caption = textFor(post, "instagram");
  let creationId;
  if (post.type === "reel") {
    ({ id: creationId } = await graph.post(`${igUserId}/media`, {
      media_type: "REELS",
      video_url: mediaUrl(post.media[0]),
      cover_url: post.cover ? mediaUrl(post.cover) : undefined,
      caption,
      share_to_feed: "true",
    }));
  } else if (post.type === "carousel") {
    const children = [];
    for (const m of post.media) {
      const { id } = await graph.post(`${igUserId}/media`, { image_url: mediaUrl(m), is_carousel_item: "true" });
      children.push(id);
    }
    for (const id of children) await waitForContainer(graph, id, opts);
    ({ id: creationId } = await graph.post(`${igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }));
  } else {
    ({ id: creationId } = await graph.post(`${igUserId}/media`, { image_url: mediaUrl(post.media[0]), caption }));
  }
  await waitForContainer(graph, creationId, opts);
  const { id } = await graph.post(`${igUserId}/media_publish`, { creation_id: creationId });
  const { permalink } = await graph.get(id, { fields: "permalink" }).catch(() => ({}));
  return { id, permalink };
}

export async function publishFacebook(graph, pageId, post, mediaUrl) {
  // Posty strony wymagają tokenu strony, który wyciągamy z tokenu użytkownika/systemowego.
  const { access_token: pageToken } = await graph.get(pageId, { fields: "access_token" });
  if (!pageToken) throw new GraphError("brak tokenu strony: sprawdź uprawnienia pages_manage_posts");
  const message = textFor(post, "facebook");
  const link = post.facebook?.link;
  if (post.type === "reel") {
    const { id } = await graph.post(`${pageId}/videos`, { file_url: mediaUrl(post.media[0]), description: message }, pageToken);
    return { id };
  }
  if (post.type === "carousel") {
    const ids = [];
    for (const m of post.media) {
      const { id } = await graph.post(`${pageId}/photos`, { url: mediaUrl(m), published: "false" }, pageToken);
      ids.push({ media_fbid: id });
    }
    const { id } = await graph.post(`${pageId}/feed`, { message, attached_media: ids }, pageToken);
    return { id };
  }
  if (post.type === "image") {
    const { id, post_id } = await graph.post(`${pageId}/photos`, { url: mediaUrl(post.media[0]), message }, pageToken);
    return { id: post_id ?? id };
  }
  const { id } = await graph.post(`${pageId}/feed`, { message, link }, pageToken);
  return { id };
}
