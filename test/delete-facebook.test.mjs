// Usuwanie z Facebooka: duplikat znika, oryginał z state/ i cudzy obiekt są odrzucane, próba nic nie usuwa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeGraph } from "../scripts/lib.mjs";
import { deleteFacebook } from "../scripts/delete-facebook.mjs";

async function mock() {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    calls.push({ method: req.method, path: p, token: url.searchParams.get("access_token") });
    const send = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
    if (p === "PAGE") return send(200, { access_token: "PAGE_TOKEN" });
    if (req.method === "GET" && p === "222") return send(200, { from: { id: "PAGE" }, created_time: "2026-11-04T17:45:40+0000" });
    if (req.method === "GET" && p === "333") return send(200, { from: { id: "OTHER" } });
    if (req.method === "DELETE" && p === "222") return send(200, { success: true });
    return send(404, { error: { message: "Unsupported request" } });
  });
  await new Promise((r) => server.listen(0, r));
  const graph = makeGraph({ base: `http://127.0.0.1:${server.address().port}`, token: "USER_TOKEN" });
  return { calls, graph, close: () => server.close() };
}

const state = { "2026-11-04-r5:facebook": { status: "published", id: "111" } };

test("usuwa duplikat strony tokenem strony, odrzuca oryginał i cudzy obiekt", async () => {
  const m = await mock();
  try {
    const r = await deleteFacebook({ ids: ["222", "111", "333", "abc"], graph: m.graph, pageId: "PAGE", state, log: () => {} });
    assert.deepEqual(r.map((x) => x.status), ["usunięte", "odrzucone", "odrzucone", "odrzucone"]);
    const del = m.calls.filter((c) => c.method === "DELETE");
    assert.deepEqual(del.map((c) => [c.path, c.token]), [["222", "PAGE_TOKEN"]]);
    assert.ok(!m.calls.some((c) => c.path === "111"), "oryginał nie jest nawet pobierany");
  } finally {
    m.close();
  }
});

test("próba niczego nie usuwa", async () => {
  const m = await mock();
  try {
    const r = await deleteFacebook({ ids: ["222"], graph: m.graph, pageId: "PAGE", state, dryRun: true, log: () => {} });
    assert.equal(r[0].status, "próba");
    assert.equal(m.calls.filter((c) => c.method === "DELETE").length, 0);
  } finally {
    m.close();
  }
});
