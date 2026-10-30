// Sprawdza konfigurację automatu: ważność i uprawnienia tokenu, stronę FB i połączone konto IG.
// Kończy się błędem (czerwony przebieg = e-mail z GitHuba), gdy coś wymaga Twojej uwagi,
// np. token wygasa za mniej niż 10 dni.
import { pathToFileURL } from "node:url";
import { makeGraph } from "./lib.mjs";

const REQUIRED = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "pages_manage_posts"];

export async function check(env = process.env, { log = console.log, fetchImpl = fetch, now = Date.now() } = {}) {
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
  return { problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  check()
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
