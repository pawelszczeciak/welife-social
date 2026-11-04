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
  return errors;
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
