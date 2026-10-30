// Sprawdza całą kolejkę przy każdym pushu, niezależnie od dat: zła treść ma wywalić
// test od razu, a nie dopiero w chwili publikacji.
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadQueue, validate, PLATFORMS } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ids = new Set();
let bad = 0;
for (const post of loadQueue(join(root, "queue"))) {
  if (ids.has(post.id)) {
    console.log(`BŁĄD ${post.file}: powtórzone id ${post.id}`);
    bad++;
  }
  ids.add(post.id);
  const platforms = post.platforms ?? [];
  if (!platforms.length || platforms.some((p) => !PLATFORMS.includes(p))) {
    console.log(`BŁĄD ${post.file}: platforms musi zawierać instagram i/lub facebook`);
    bad++;
  }
  for (const platform of platforms) {
    const errors = validate(post, platform, root);
    for (const e of errors) console.log(`BŁĄD ${post.file} [${platform}]: ${e}`);
    bad += errors.length;
    if (!errors.length) console.log(`OK   ${post.file} [${platform}] ${post.publish_at}`);
  }
}
process.exit(bad ? 1 : 0);
