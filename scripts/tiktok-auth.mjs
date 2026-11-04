// Jednorazowe podłączenie konta TikTok do automatu. Uruchamiasz u siebie (Node 22+):
//
//   TIKTOK_CLIENT_KEY=... TIKTOK_CLIENT_SECRET=... node scripts/tiktok-auth.mjs
//
// 1. Skrypt wypisze adres autoryzacji: otwórz go w przeglądarce zalogowanej na konto TikTok WE.LIFE.
// 2. Po zgodzie TikTok przekieruje Cię na TIKTOK_REDIRECT_URI z ?code=...: skopiuj CAŁY adres z paska.
// 3. Wklej go tutaj. Skrypt wymieni kod na tokeny i wypisze tylko dwie wartości do sekretów GitHuba:
//    TIKTOK_REFRESH_TOKEN i TIKTOK_VAULT_KEY. Access tokenu nie wypisuje.
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const { TIKTOK_CLIENT_KEY: clientKey, TIKTOK_CLIENT_SECRET: clientSecret } = process.env;
const redirectUri = process.env.TIKTOK_REDIRECT_URI || "https://welife.world/";
if (!clientKey || !clientSecret) {
  console.error("Ustaw TIKTOK_CLIENT_KEY i TIKTOK_CLIENT_SECRET (developers.tiktok.com → aplikacja → App credentials).");
  process.exit(2);
}

const state = randomBytes(12).toString("hex");
const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
authorize.search = new URLSearchParams({
  client_key: clientKey,
  scope: "user.info.basic,video.publish",
  response_type: "code",
  redirect_uri: redirectUri,
  state,
}).toString();

console.log("\n1) Otwórz ten adres w przeglądarce zalogowanej na konto TikTok WE.LIFE i zatwierdź dostęp:\n");
console.log(authorize.toString());
console.log(`\n2) TikTok przekieruje Cię na ${redirectUri}?code=...  Skopiuj CAŁY adres z paska przeglądarki.\n`);

const rl = createInterface({ input: stdin, output: stdout });
const pasted = (await rl.question("3) Wklej adres tutaj i naciśnij Enter: ")).trim();
rl.close();

let code;
try {
  const back = new URL(pasted);
  if (back.searchParams.get("state") !== state) throw new Error("state się nie zgadza: użyj adresu z tej samej próby");
  if (back.searchParams.get("error")) throw new Error(`TikTok zwrócił błąd: ${back.searchParams.get("error_description") ?? back.searchParams.get("error")}`);
  code = back.searchParams.get("code"); // URLSearchParams zwraca już zdekodowany kod, tak jak wymaga TikTok
} catch (e) {
  console.error(`Nie udało się odczytać kodu: ${e.message}`);
  process.exit(1);
}
if (!code) {
  console.error("W adresie nie ma parametru code.");
  process.exit(1);
}

const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }),
});
const json = await res.json().catch(() => ({}));
if (!res.ok || json.error || !json.refresh_token) {
  console.error(`Wymiana kodu nie powiodła się: ${json.error_description ?? json.error ?? res.status}`);
  process.exit(1);
}
if (!String(json.scope ?? "").includes("video.publish")) {
  console.error(`Konto nie przyznało uprawnienia video.publish (przyznane: ${json.scope}). Sprawdź produkt Content Posting API w aplikacji.`);
  process.exit(1);
}

const vaultKey = process.env.TIKTOK_VAULT_KEY || randomBytes(32).toString("base64");
console.log("\nGotowe. Wpisz w GitHubie (welife-social → Settings → Secrets and variables → Actions → Secrets):\n");
console.log(`TIKTOK_REFRESH_TOKEN = ${json.refresh_token}`);
if (process.env.TIKTOK_VAULT_KEY) console.log("TIKTOK_VAULT_KEY     = (bez zmian, użyty istniejący)");
else console.log(`TIKTOK_VAULT_KEY     = ${vaultKey}`);
console.log(`\nRefresh token jest ważny ok. ${Math.round(Number(json.refresh_expires_in ?? 0) / 86400)} dni i odnawia się przy każdej publikacji.`);
console.log("Nie wklejaj tych wartości nigdzie poza sekretami GitHuba.\n");
