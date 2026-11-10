// Uzgodnienie WYŁĄCZNIE wskazanej pozycji "failed"/"retry" z tym, co operator widzi na platformie:
// post wyszedł mimo błędu API (K4 PL IG: 3 kopie przy statusie failed). Nic nie publikuje i niczego
// nie usuwa; zapisuje w stanie id posta, który zostaje oficjalnym, oraz id widocznych kopii.
// Domyślnie tylko próba (nic nie zapisuje). Klucz zawsze jako pierwszy argument.
//
//   node scripts/reconcile.mjs <post:platforma> --id <id> [--permalink <url>] [--duplicate <id>[=<url>]]...
//   ... --apply --expect-sha256 <hex> --observed-on-platform "<kto, kiedy (UTC), gdzie widział post>"
//
// Po zapisie status to "published": publikator i requeue już tej pozycji nie ruszą, alarm znika.
// Wypychanie jak przy requeue: bez --force, gdy nie trwa przebieg "Publikacja".
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeStateCas } from "./requeue.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const ID = /^[0-9]+(_[0-9]+)?$/;
const URL_OK = /^https:\/\/(www\.)?(instagram|facebook)\.com\//;

function parseDuplicate(d) {
  const [id, permalink] = d.split("=");
  if (!ID.test(id ?? "")) throw new Error(`zły identyfikator kopii: ${d}`);
  if (permalink !== undefined && !URL_OK.test(permalink)) throw new Error(`zły adres kopii: ${d}`);
  return permalink ? { id, permalink } : { id };
}

export function reconcile(key, { id, permalink = null, duplicates = [], root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), apply = false, expectSha256 = null, observed = null, now = Date.now(), log = console.log } = {}) {
  if (!/^[A-Za-z0-9._-]+:(instagram|facebook|tiktok)$/.test(key ?? "")) throw new Error(`zły klucz: ${key}`);
  if (!ID.test(id ?? "")) throw new Error("--id: podaj identyfikator posta widoczny na platformie (cyfry)");
  if (permalink && !URL_OK.test(permalink)) throw new Error("--permalink musi być adresem https://instagram.com/… albo https://facebook.com/…");
  const dups = duplicates.map(parseDuplicate);
  if (dups.some((d) => d.id === id)) throw new Error("kopia nie może mieć tego samego id co post oficjalny");
  const statePath = join(root, "state", "published.json");
  if (!existsSync(statePath)) throw new Error("brak state/published.json");
  const text = readFileSync(statePath, "utf8");
  const digest = sha256(text);
  const e = JSON.parse(text)[key];
  if (!e) throw new Error(`${key}: brak wpisu w stanie`);
  if (!["failed", "retry"].includes(e.status)) throw new Error(`${key}: status "${e.status}", uzgadniam tylko "failed"/"retry"`);
  if (e.id || e.permalink) throw new Error(`${key}: wpis ma już id/permalink, nie nadpisuję`);
  log(`${apply ? "UZGADNIAM" : "[próba] uzgodniłbym"} ${key} → published, id ${id}${permalink ? ` ${permalink}` : ""}${dups.length ? `, kopie: ${dups.map((d) => d.id).join(", ")}` : ""}`);
  log(`sha256 stanu: ${digest}`);
  if (!apply) return { applied: false, sha256: digest };

  if (!expectSha256) throw new Error("--apply wymaga --expect-sha256 <skrót z próby>");
  if (expectSha256.toLowerCase() !== digest) throw new Error(`stan zmienił się od próby (oczekiwano ${expectSha256}, jest ${digest}); zrób git pull i powtórz próbę`);
  if (!(typeof observed === "string" && observed.trim().length >= 8)) throw new Error('--apply wymaga --observed-on-platform "<kto, kiedy, gdzie widział post>"');

  writeStateCas(root, digest, (next) => {
    const cur = next[key];
    next[key] = {
      ...cur,
      status: "published",
      id,
      ...(permalink ? { permalink } : {}),
      reconciled_at: new Date(now).toISOString(),
      reconcile_basis: "operator_observed",
      observed_on_platform: observed.trim(),
      reconciled_from: { status: cur.status, attempts: cur.attempts, error: cur.error, updated_at: cur.updated_at },
      ...(dups.length ? { duplicates_on_platform: dups } : {}),
    };
    delete next[key].error;
  });
  return { applied: true, sha256: digest };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  try {
    reconcile(args[0], {
      id: opt("--id"),
      permalink: opt("--permalink"),
      duplicates: all("--duplicate"),
      apply: args.includes("--apply"),
      expectSha256: opt("--expect-sha256"),
      observed: opt("--observed-on-platform"),
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
