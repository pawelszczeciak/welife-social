// Wspólne funkcje automatu: kolejka, walidacja, klient Graph API, publikacja IG i FB.
// TikTok ma własny moduł: scripts/tiktok.mjs.
// Bez zależności: Node 22+ (fetch, node:test).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const PLATFORMS = ["instagram", "facebook", "tiktok", "youtube", "pinterest"];
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
  if (platform === "youtube") {
    if (post.youtube?.description) return post.youtube.description;
    // Na YouTube nie ma „linku w bio”: kierujemy wprost na stronę i dodajemy link z oznaczeniem źródła.
    const base = (post.caption ?? "").replace(/w bio @welife\.world/g, "na welife.world").replace(/in our bio @welife\.world/g, "at welife.world");
    return `${base}\n\nhttps://welife.world/?utm_source=youtube&utm_medium=social&utm_campaign=${post.id}`;
  }
  if (platform === "pinterest") {
    if (post.pinterest?.description) return post.pinterest.description;
    // Pin ma własny klikalny link, więc bez „linku w bio”, bez pytania do komentujących (pierwszy akapit)
    // i bez samych hashtagów; całe akapity, dopóki mieszczą się w 800 znakach.
    const paras = (post.caption ?? "").split(/\n{2,}/).slice(1)
      .map((x) => x.replace(/Link\b[^\n]*?w bio @welife\.world\.\s*/g, "").trim())
      .filter((x) => x && !/^(#\S+\s*)+$/u.test(x));
    let out = "";
    for (const x of paras) {
      const next = out ? `${out}\n\n${x}` : x;
      if (next.length > 800) break;
      out = next;
    }
    return out;
  }
  return post.caption ?? "";
}

// Pinterest: tytuł = post.pinterest.title albo pierwsze zdanie pierwszej linii opisu (do 100 znaków).
export function pinterestTitle(post) {
  if (post.pinterest?.title) return post.pinterest.title;
  const line = (post.caption ?? "").split("\n")[0].trim();
  const first = /^.*?[?!.](?=\s|$)/.exec(line)?.[0] ?? line;
  return first.length <= 100 ? first : first.slice(0, 99).replace(/\s+\S*$/, "") + "…";
}

// Pin to jeden obraz albo jeden film: dla karuzeli post.pinterest.media albo pierwszy slajd.
export const pinterestMedia = (post) => post.pinterest?.media ?? post.media?.[0];
export const pinterestLink = (post) =>
  post.pinterest?.link ?? `https://welife.world/?utm_source=pinterest&utm_medium=social&utm_campaign=${post.id}`;

// Tytuł filmu na YouTube: post.youtube.title albo pierwsza linia opisu, przycięta do 100 znaków na granicy słowa.
export function youtubeTitle(post) {
  if (post.youtube?.title) return post.youtube.title;
  const line = (post.caption ?? "").split("\n")[0].trim();
  if (line.length <= 100) return line;
  return line.slice(0, 99).replace(/\s+\S*$/, "") + "…";
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
  if (platform === "youtube") {
    if (post.type !== "reel") errors.push("YouTube w tym automacie przyjmuje tylko rolki (type: reel)");
    const title = youtubeTitle(post);
    if (!title) errors.push("YouTube: pusty tytuł (pierwsza linia opisu)");
    if (title.length > 100) errors.push(`YouTube: tytuł ma ${title.length} znaków, limit to 100`);
    if (/[<>]/.test(title)) errors.push("YouTube: tytuł nie może zawierać znaków < ani >");
    if (text.length > 5000) errors.push("YouTube: opis dłuższy niż 5000 znaków");
  }
  if (!text.trim()) errors.push("pusty tekst");
  if (text.includes("{{")) errors.push("tekst zawiera niewypełnione pole {{…}}");
  // Zasada właściciela: każdy materiał mówi, że to wersja beta (testowa).
  if (!/beta/i.test(text)) errors.push("tekst nie mówi, że WE.LIFE to wersja beta");
  if (post.ai_imagery && !/\bAI\b/.test(text)) errors.push("obrazy AI bez informacji „AI” w tekście");
  if (platform === "pinterest") {
    if (!["reel", "image", "carousel"].includes(post.type)) errors.push("Pinterest przyjmuje tylko obraz, karuzelę (jeden slajd) albo rolkę");
    const title = pinterestTitle(post);
    if (!title) errors.push("Pinterest: pusty tytuł");
    if (title.length > 100) errors.push(`Pinterest: tytuł ma ${title.length} znaków, limit to 100`);
    if (text.length > 800) errors.push(`Pinterest: opis ma ${text.length} znaków, limit to 800`);
    if (!/^https:\/\/welife\.world\//.test(pinterestLink(post))) errors.push("Pinterest: link musi prowadzić na https://welife.world/");
    const m = pinterestMedia(post) ?? "";
    if (post.type !== "reel" && !/\.(jpe?g|png|webp)$/i.test(m)) errors.push("Pinterest: pin obrazkowy wymaga pliku JPEG, PNG albo WebP");
    if (post.type !== "reel" && !(post.media ?? []).includes(m)) errors.push("Pinterest: pinterest.media musi być jednym z plików posta");
  }
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
  // Ostatnio widziane nagłówki zużycia limitów (X-App-Usage, X-Business-Use-Case-Usage), tylko do diagnostyki.
  // Meta dołącza je nie do każdej odpowiedzi, więc brak nagłówka nie kasuje poprzedniej wartości.
  let usage = { app: null, buc: null };
  async function call(method, path, params = {}, accessToken = token) {
    const body = new URLSearchParams({ ...stringify(params), access_token: accessToken });
    const res =
      method === "GET" || method === "DELETE"
        ? await fetchImpl(`${url(path)}?${body}`, { method })
        : await fetchImpl(url(path), { method, body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    usage = { app: res.headers?.get?.("x-app-usage") ?? usage.app, buc: res.headers?.get?.("x-business-use-case-usage") ?? usage.buc };
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
    usage: () => usage,
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

const normCaption = (s) => (s ?? "").replace(/\s+/g, " ").trim();
export const sameCaption = (a, b) => normCaption(a).length > 0 && normCaption(a) === normCaption(b);

const MEDIA_PAGE = 50;
const review = (message) => new GraphError(message, { needsReview: true });

// Czy na koncie jest post z identycznym opisem, opublikowany nie wcześniej niż `since` − 5 min (ms).
// Wynik jest jednym z trzech, a niepewność NIGDY nie staje się ani "jest", ani "nie ma":
//   { status: "found", id, permalink, copies }  – co najmniej jeden pasujący post z id i poprawnym czasem,
//   { status: "absent" }                         – strona sięga przed dolną granicę albo jest całym kontem,
//   { status: "inconclusive", reason }           – brak/zła granica, pasujący post bez id lub czasu,
//                                                  albo pełna strona bez dojścia do granicy (paginacja).
// Ten sam opis opublikowany dni wcześniej (przed granicą) nie jest dopasowaniem.
export async function findInstagramByCaption(graph, igUserId, caption, since) {
  if (!Number.isFinite(since) || since <= 0) return { status: "inconclusive", reason: "brak poprawnej dolnej granicy czasu" };
  const lower = since - 5 * 60 * 1000;
  const page = await graph.get(`${igUserId}/media`, { fields: "id,caption,timestamp,permalink", limit: MEDIA_PAGE });
  if (!Array.isArray(page?.data)) return { status: "inconclusive", reason: "odpowiedź bez listy postów" };
  let oldest = Infinity;
  const hits = [];
  for (const m of page.data) {
    const at = Date.parse(m?.timestamp);
    const match = sameCaption(m?.caption, caption);
    if (!Number.isFinite(at)) {
      if (match) return { status: "inconclusive", reason: "pasujący post bez poprawnego czasu" };
      continue;
    }
    oldest = Math.min(oldest, at);
    if (!match || at < lower) continue;
    if (!m.id) return { status: "inconclusive", reason: "pasujący post bez id" };
    hits.push({ id: String(m.id), permalink: m.permalink, at });
  }
  if (hits.length) {
    hits.sort((a, b) => a.at - b.at);
    return { status: "found", id: hits[0].id, permalink: hits[0].permalink, copies: hits.map((h) => h.id) };
  }
  const wholeAccount = !page.paging?.next && page.data.length < MEDIA_PAGE;
  if (oldest < lower || wholeAccount) return { status: "absent" };
  return { status: "inconclusive", reason: `${page.data.length} najnowszych postów nie sięga do granicy czasu` };
}

// K4 PL IG: media_publish trzy razy zwrócił "Application request limit reached", a post i tak wyszedł
// za każdym razem (3 kopie). Przed ponowieniem z zapisanym kontenerem NAJPIERW: stan kontenera i ostatnie posty.
// Wyłącznie rozstrzygająca nieobecność posta pozwala na dalsze POST-y:
//   FINISHED → ponownie ten sam kontener (nie wyszedł i nadal można go opublikować),
//   EXPIRED  → nowy kontener (Meta: "nie opublikowany w ciągu 24 h i wygasł", więc ten kontener nie wyszedł),
//   IN_PROGRESS → czekamy (błąd bez POST-a, kolejna próba później),
//   PUBLISHED, ERROR, inny lub brak statusu → sprawdzenie ręczne, bez POST-a.
// Każdy błąd odczytu przerywa próbę przed jakimkolwiek POST-em.
async function reconcileInstagram(graph, igUserId, creationId, caption, since) {
  const { status_code: code } = (await graph.get(creationId, { fields: "status_code" })) ?? {};
  const search = await findInstagramByCaption(graph, igUserId, caption, since);
  if (search.status === "found") return { action: "reconciled", ...search, containerStatus: code };
  if (search.status !== "absent") throw review(`kontener ${creationId} (${code ?? "brak statusu"}): nie da się rozstrzygnąć, czy post wyszedł (${search.reason}); bez ponownej publikacji`);
  if (code === "FINISHED") return { action: "reuse" };
  if (code === "EXPIRED") return { action: "new" };
  if (code === "IN_PROGRESS") throw new GraphError(`kontener ${creationId}: IN_PROGRESS, czekam na kolejną próbę (bez publikacji)`, { stage: "reconcile" });
  throw review(`kontener ${creationId}: ${code ?? "brak statusu"}, a posta nie ma na koncie; wymaga sprawdzenia ręcznego, bez ponownej publikacji`);
}

// opts.creationId/opts.since: kontener z poprzedniej próby i czas jego utworzenia (ms).
// opts.dueAt: termin posta (ms); bez zapisanego kontenera sprawdzamy, czy post z tym opisem nie wyszedł już od
//   terminu (np. stan poprzedniego przebiegu nie został wypchnięty) – wtedy sprawdzenie ręczne, nie publikacja.
// opts.checkpoint(patch): trwały zapis stanu PRZED media_publish (kontener) i ZARAZ po nim (id posta), żeby
//   przerwanie przebiegu albo zgubiona odpowiedź nie kończyły się ślepym ponowieniem.
// Każdy błąd po utworzeniu kontenera niesie e.creationId.
export async function publishInstagram(graph, igUserId, post, mediaUrl, opts = {}) {
  const caption = textFor(post, "instagram");
  const checkpoint = opts.checkpoint ?? (() => {});
  let creationId = opts.creationId ?? null;
  try {
    if (creationId) {
      const r = await reconcileInstagram(graph, igUserId, creationId, caption, opts.since);
      if (r.action === "reconciled") return { id: r.id, permalink: r.permalink, reconciled: true, containerStatus: r.containerStatus, copies: r.copies };
      if (r.action === "new") creationId = null;
    } else {
      const prior = await findInstagramByCaption(graph, igUserId, caption, opts.dueAt);
      if (prior.status === "found") throw review(`post z identycznym opisem jest już na koncie od terminu (${prior.permalink ?? prior.id}); stan go nie zna, bez publikacji`);
      if (prior.status !== "absent") throw review(`nie da się sprawdzić, czy post już wyszedł (${prior.reason}); bez publikacji`);
    }
    if (!creationId && post.type === "reel") {
      ({ id: creationId } = await graph.post(`${igUserId}/media`, {
        media_type: "REELS",
        video_url: mediaUrl(post.media[0]),
        cover_url: post.cover ? mediaUrl(post.cover) : undefined,
        caption,
        share_to_feed: "true",
      }));
    } else if (!creationId && post.type === "carousel") {
      const children = [];
      for (const m of post.media) {
        const { id } = await graph.post(`${igUserId}/media`, { image_url: mediaUrl(m), is_carousel_item: "true" });
        children.push(id);
      }
      for (const id of children) await waitForContainer(graph, id, opts);
      ({ id: creationId } = await graph.post(`${igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }));
    } else if (!creationId) {
      ({ id: creationId } = await graph.post(`${igUserId}/media`, { image_url: mediaUrl(post.media[0]), caption }));
    }
    await waitForContainer(graph, creationId, opts);
    checkpoint({ creation_id: creationId });
    const { id } = await graph.post(`${igUserId}/media_publish`, { creation_id: creationId });
    checkpoint({ creation_id: creationId, media_id: id });
    const { permalink } = await graph.get(id, { fields: "permalink" }).catch(() => ({}));
    return { id, permalink };
  } catch (e) {
    if (creationId) e.creationId = creationId;
    throw e;
  }
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
