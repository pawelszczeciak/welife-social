// Wznowienie WYŁĄCZNIE wskazanych pozycji w stanie "failed". Domyślnie tylko próba (nic nie zapisuje).
//
//   node scripts/requeue.mjs <post:platforma> [...]                                  # próba + wypisuje sha256 stanu
//   node scripts/requeue.mjs <post:platforma> [...] --apply --expect-sha256 <hex>
//        --verified-absent-on-platform "<kto/kiedy sprawdził stronę FB i konto IG>"
//
// CO TO ZABEZPIECZA, A CZEGO NIE:
//  * --expect-sha256 to porównanie-i-zamiana (CAS) na poziomie PLIKU lokalnego: zapis tylko, jeśli
//    state/published.json ma dokładnie ten skrót, który operator zobaczył w próbie. Blokada pliku
//    (state/.requeue.lock, O_EXCL) chroni przed dwoma równoczesnymi requeue na tym samym katalogu.
//  * To NIE jest blokada wobec publikatora w GitHub Actions: on pracuje na własnej kopii repo i zapisuje
//    stan przez `git pull --rebase && git push`. Jedyny rzeczywisty CAS wobec niego to fast-forward push:
//    wypychaj BEZ --force, a gdy push zostanie odrzucony, zrób `git pull`, powtórz próbę (nowy skrót) i apply.
//    Dodatkowo wypychaj, gdy w Actions nie trwa przebieg "Publikacja" (gh run list --workflow publish.yml --status in_progress).
//  * Brak "id" w stanie NIE dowodzi, że nic nie wyszło (utrata odpowiedzi po /feed, przerwany przebieg
//    przed zapisem stanu). Dlatego zawsze wymagane jest --verified-absent-on-platform. Jedyny wyjątek:
//    kompletna historia prób (history.length === attempts), w której KAŻDY wpis ma stage "probe"
//    (błąd przed wywołaniem Graph/Zernio) i brak id/permalinku.
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function provenBeforeApi(e) {
  const h = Array.isArray(e.history) ? e.history : [];
  return h.length > 0 && h.length === e.attempts && h.every((x) => x?.stage === "probe");
}

export function requeue(keys, { root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), apply = false, expectSha256 = null, verifiedAbsent = null, now = Date.now(), log = console.log } = {}) {
  if (!keys.length) throw new Error("podaj co najmniej jeden klucz w formie <post>:<platforma>");
  const statePath = join(root, "state", "published.json");
  if (!existsSync(statePath)) throw new Error("brak state/published.json");
  const text = readFileSync(statePath, "utf8");
  const digest = sha256(text);
  const state = JSON.parse(text);
  const plan = [];
  for (const key of keys) {
    if (!/^[A-Za-z0-9._-]+:(instagram|facebook|tiktok)$/.test(key)) throw new Error(`zły klucz: ${key}`);
    const e = state[key];
    if (!e) throw new Error(`${key}: brak wpisu w stanie`);
    if (e.status !== "failed") throw new Error(`${key}: status "${e.status}", wznawiam tylko "failed"`);
    if (e.id || e.permalink) throw new Error(`${key}: wpis ma id/permalink, platforma mogła już opublikować post (odmowa, ryzyko duplikatu)`);
    plan.push(key);
  }
  for (const key of plan) log(`${apply ? "WZNAWIAM" : "[próba] wznowiłbym"} ${key}`);
  log(`sha256 stanu: ${digest}`);
  if (!apply) return { applied: false, keys: plan, sha256: digest };

  if (!expectSha256) throw new Error("--apply wymaga --expect-sha256 <skrót z próby>");
  if (expectSha256.toLowerCase() !== digest) throw new Error(`stan zmienił się od próby (oczekiwano ${expectSha256}, jest ${digest}); zrób git pull i powtórz próbę`);
  for (const key of plan) {
    if (!provenBeforeApi(state[key]) && !(typeof verifiedAbsent === "string" && verifiedAbsent.trim().length >= 8)) {
      throw new Error(`${key}: brak dowodu, że nic nie wyszło (historia prób niekompletna lub po wywołaniu API). Sprawdź stronę FB / konto IG i podaj --verified-absent-on-platform "<kto, kiedy>"`);
    }
  }

  // Blokada wyłączności lokalna + ponowny odczyt i porównanie skrótu tuż przed zapisem.
  const lockPath = join(root, "state", ".requeue.lock");
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    throw new Error("inny requeue trwa (state/.requeue.lock); jeśli to pozostałość, usuń plik po sprawdzeniu");
  }
  try {
    const fresh = readFileSync(statePath, "utf8");
    if (sha256(fresh) !== digest) throw new Error("stan zmienił się w trakcie, przerwano bez zapisu");
    const next = JSON.parse(fresh);
    for (const key of plan) {
      const e = next[key];
      next[key] = {
        attempts: 0,
        requeued_at: new Date(now).toISOString(),
        requeued_from: { status: e.status, attempts: e.attempts, error: e.error, updated_at: e.updated_at, history: e.history },
        ...(provenBeforeApi(e) ? { requeue_basis: "history_all_probe" } : { requeue_basis: "operator_verified", verified_absent_on_platform: verifiedAbsent.trim() }),
      };
    }
    const sorted = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n");
    renameSync(tmp, statePath);
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
  return { applied: true, keys: plan, sha256: digest };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const valueIdx = new Set(["--expect-sha256", "--verified-absent-on-platform"].flatMap((n) => (args.includes(n) ? [args.indexOf(n) + 1] : [])));
  try {
    requeue(args.filter((a, i) => !a.startsWith("--") && !valueIdx.has(i)), {
      apply: args.includes("--apply"),
      expectSha256: opt("--expect-sha256"),
      verifiedAbsent: opt("--verified-absent-on-platform"),
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
