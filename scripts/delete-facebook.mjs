// Usuwa z fanpage'a wskazane posty/filmy (np. duplikaty po błędzie publikacji).
// Uruchamiane ręcznie z GitHub Actions („Usuń posty z Facebooka”), bo token strony jest tylko w sekretach.
//
// Bezpieczniki:
// - nie usunie niczego, co state/published.json ma jako "published" (to oryginały z kolejki);
//   żeby celowo usunąć oryginał (np. podmiana na nową wersję), najpierw ustaw mu w stanie "removed";
// - usuwa tylko obiekty, których autorem jest nasza strona (FB_PAGE_ID);
// - DRY_RUN=true tylko pokazuje, co by usunął.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeGraph, GraphError } from "./lib.mjs";

export async function deleteFacebook({ ids, graph, pageId, state = {}, dryRun = false, log = console.log }) {
  const protectedIds = new Set(
    Object.entries(state)
      .filter(([key, v]) => key.endsWith(":facebook") && v.status === "published")
      .flatMap(([, v]) => [v.id, String(v.id ?? "").split("_").pop()])
      .filter(Boolean),
  );
  const { access_token: pageToken } = await graph.get(pageId, { fields: "access_token" });
  if (!pageToken) throw new GraphError("brak tokenu strony: sprawdź uprawnienia pages_manage_posts");
  const results = [];
  for (const id of ids) {
    if (!/^\d+(_\d+)?$/.test(id)) {
      results.push({ id, status: "odrzucone", reason: "to nie jest identyfikator Facebooka" });
      continue;
    }
    if (protectedIds.has(id) || protectedIds.has(id.split("_").pop())) {
      results.push({ id, status: "odrzucone", reason: "to oryginał opublikowany z kolejki (state/published.json)" });
      continue;
    }
    let obj;
    try {
      obj = await graph.get(id, { fields: "from,created_time" }, pageToken);
    } catch (e) {
      results.push({ id, status: "błąd", reason: e.message });
      continue;
    }
    if (String(obj.from?.id) !== String(pageId)) {
      results.push({ id, status: "odrzucone", reason: "autorem nie jest nasza strona" });
      continue;
    }
    if (dryRun) {
      results.push({ id, status: "próba", created: obj.created_time });
      continue;
    }
    try {
      await graph.del(id, {}, pageToken);
      results.push({ id, status: "usunięte", created: obj.created_time });
    } catch (e) {
      results.push({ id, status: "błąd", reason: e.message });
    }
  }
  for (const r of results) log(`${r.status.toUpperCase()} ${r.id}${r.created ? ` (z ${r.created})` : ""}${r.reason ? `: ${r.reason}` : ""}`);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ids = (process.env.IDS ?? "").split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0) {
    console.error("podaj IDS (identyfikatory oddzielone przecinkami)");
    process.exit(2);
  }
  const graph = makeGraph({ version: process.env.GRAPH_VERSION || "v23.0", token: process.env.META_ACCESS_TOKEN });
  const state = JSON.parse(readFileSync(resolve("state/published.json"), "utf8"));
  const results = await deleteFacebook({
    ids, graph, pageId: process.env.FB_PAGE_ID, state, dryRun: process.env.DRY_RUN === "true",
  });
  if (results.some((r) => r.status !== "usunięte" && r.status !== "próba")) process.exit(1);
}
