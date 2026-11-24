// Strony-odpowiedzi: statyczne strony „ile czego na ile osób”, liczone przez sam planer Wigilii.
//
//   node narzedzia/strony-odpowiedzi.cjs
//
// Skrypt otwiera site/wigilia/index.html w Chromium, wywołuje funkcję planera `zakupy()` dla każdej potrawy
// i liczby osób, a potem zapisuje gotowe strony HTML do site/wigilia/. Ilości nie są wpisane tu ręcznie:
// po każdej zmianie danych w planerze uruchom skrypt ponownie i wyślij katalog site/ na GitHub Pages.
// Po przeniesieniu planera do domeny ustaw adres bazowy: BAZA=https://welife.world/wigilia/ node narzedzia/strony-odpowiedzi.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SITE = path.resolve(__dirname, "../site");
const PLANER = path.join(SITE, "wigilia/index.html");
const BAZA = (process.env.BAZA || "https://pawelszczeciak.github.io/welife-social/wigilia/").replace(/\/?$/, "/");
const DZIS = new Date().toISOString().slice(0, 10);

const NS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40]; // wiersze tabeli
const WYBOR = [2, 4, 6, 8, 10, 12, 15, 20, 30]; // przyciski wyboru (planer przyjmuje 2–30 osób)
const LISTY = [4, 6, 8, 10, 12]; // gotowe listy zakupów na całą Wigilię

// Potrawy, o które ludzie pytają w wyszukiwarce. `porcja` musi zgadzać się z opisem porcji w planerze (sprawdzane niżej).
const POTRAWY = {
  barszcz: { slug: "ile-barszczu-na-osobe", czego: "barszczu", h1: "Ile barszczu na osobę?", porcja: 250, jedn: "ml", kol: "Barszcz", link: "Ile barszczu na osobę?" },
  uszka: { slug: "ile-uszek-na-osobe", czego: "uszek", h1: "Ile uszek na osobę?", porcja: 6, jedn: "szt.", kol: "Uszka", link: "Ile uszek na osobę?" },
  pierogi: { slug: "ile-pierogow-na-osobe", czego: "pierogów", h1: "Ile pierogów na osobę na Wigilię?", porcja: 6, jedn: "szt.", kol: "Pierogi", link: "Ile pierogów na osobę?" },
  karp: { slug: "ile-karpia-na-osobe", czego: "karpia", h1: "Ile karpia na osobę?", porcja: 1, jedn: "dzwonko", kol: "Karp", link: "Ile karpia na osobę?" },
  sledzie: { slug: "ile-sledzi-na-osobe", czego: "śledzi", h1: "Ile śledzi na osobę?", porcja: 60, jedn: "g", kol: "Śledzie", link: "Ile śledzi na osobę?" },
  grecka: { slug: "ile-ryby-po-grecku-na-osobe", czego: "ryby po grecku", h1: "Ile ryby po grecku na osobę?", porcja: 200, jedn: "g", kol: "Ryba po grecku", link: "Ile ryby po grecku na osobę?" },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kilka = (n) => n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
const osob = (n) => `${n} ${n === 1 ? "osoba" : kilka(n) ? "osoby" : "osób"}`;
const pozycji = (n) => `${n} ${n === 1 ? "pozycja" : kilka(n) ? "pozycje" : "pozycji"}`;
const liczba = (x) => x.toLocaleString("pl-PL", { maximumFractionDigits: 2 });
function ile(x, j) {
  if (j === "ml") return x >= 1000 ? liczba(x / 1000) + " l" : x + " ml";
  if (j === "g") return x >= 1000 ? liczba(x / 1000) + " kg" : x + " g";
  if (j === "dzwonko") return x + " " + (x === 1 ? "dzwonko" : kilka(x) ? "dzwonka" : "dzwonek");
  return x + " " + j;
}
const slugListy = (n) => `lista-zakupow/na-${n}-${kilka(n) ? "osoby" : "osob"}/`;
const KIEDY = { 2: "2 dni przed Wigilią", 1: "Dzień przed Wigilią", 0: "W Wigilię" };

const CSS = `
  :root { --teal:#0A6C78; --dark:#084E57; --light:#D6EBEE; --bg:#F2F6F7; --ink:#0F2428; --muted:#46585C; --hl:#52C5D2; --line:#C9DADD; --card:#fff; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--ink); font:400 17px/1.5 Figtree,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:0 16px; }
  header.top { background:var(--dark); color:#fff; padding:22px 0 28px; }
  .brand { font-weight:800; letter-spacing:.06em; font-size:15px; color:var(--hl); text-decoration:none; }
  .back { display:inline-block; margin-left:14px; color:var(--light); font-size:15px; }
  h1 { font-size:clamp(30px,7vw,44px); line-height:1.08; margin:14px 0 10px; font-weight:800; letter-spacing:-.01em; text-wrap:balance; }
  header.top p { margin:0; color:var(--light); font-size:18px; max-width:34em; }
  h2 { font-size:24px; line-height:1.2; margin:0 0 8px; font-weight:800; text-wrap:balance; }
  section { padding:26px 0 4px; }
  section > p { margin:0 0 12px; max-width:38em; }
  .hint { color:var(--muted); font-size:15px; margin:0 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:16px; }
  .ans { margin:0; font:800 clamp(40px,11vw,60px)/1 Figtree,sans-serif; color:var(--dark); font-variant-numeric:tabular-nums; }
  .ans + p { margin:6px 0 0; font-weight:600; color:var(--muted); }
  .pick { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 0; }
  .pick button { min-width:48px; min-height:44px; padding:8px 12px; border-radius:12px; border:2px solid var(--line); background:#fff; color:var(--ink); font:700 16px/1 Figtree,sans-serif; cursor:pointer; }
  .pick button[aria-pressed=true] { border-color:var(--teal); background:var(--teal); color:#fff; }
  .pick button:focus-visible, .btn:focus-visible, a:focus-visible { outline:3px solid var(--hl); outline-offset:2px; }
  .rows { margin:14px 0 0; }
  .row { display:flex; justify-content:space-between; gap:14px; padding:9px 0; border-top:1px solid #E4EDEF; }
  .row b { white-space:nowrap; font-variant-numeric:tabular-nums; }
  .group h3 { margin:14px 0 2px; font-size:14px; letter-spacing:.06em; text-transform:uppercase; color:var(--teal); font-weight:800; }
  .group:first-child h3 { margin-top:0; }
  .group .row:first-of-type, .card > .row:first-child { border-top:0; }
  .tab { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:16px; }
  th, td { text-align:left; padding:10px 10px 10px 0; border-top:1px solid #E4EDEF; vertical-align:top; }
  thead th { border-top:0; font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:var(--teal); }
  td.n, td.q { white-space:nowrap; font-weight:700; font-variant-numeric:tabular-nums; }
  td.s { color:var(--muted); font-size:15px; }
  .check { margin:10px 0 0; padding:12px 14px; background:var(--light); border-radius:12px; font-size:15px; }
  .day { margin:0 0 12px; }
  .day h3 { margin:0 0 8px; font-size:18px; font-weight:800; }
  .day h3 small { font-weight:600; color:var(--muted); font-size:14px; margin-left:8px; }
  .day ul { margin:0; padding:0; list-style:none; }
  .day li { padding:7px 0 7px 18px; border-top:1px solid #E4EDEF; position:relative; }
  .day li:first-child { border-top:0; }
  .day li::before { content:""; position:absolute; left:2px; top:16px; width:8px; height:8px; border-radius:50%; background:var(--hl); }
  .cta { background:var(--dark); color:#fff; border-radius:22px; padding:24px 20px; margin:30px 0 6px; }
  .cta h2 { color:#fff; }
  .cta p { margin:0 0 16px; color:var(--light); }
  .btn { appearance:none; border:0; border-radius:12px; padding:13px 18px; min-height:48px; font:700 16px/1.1 Figtree,sans-serif; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; background:#fff; color:var(--dark); }
  .links { display:grid; gap:8px; padding:0; margin:0; list-style:none; }
  .links a { display:block; padding:12px 14px; border:1px solid var(--line); border-radius:12px; background:#fff; color:var(--dark); font-weight:700; text-decoration:none; }
  .links a:hover { border-color:var(--teal); }
  main a:not(.btn):not(.links a) { color:var(--teal); font-weight:600; }
  footer { color:var(--muted); font-size:14px; padding:22px 0 40px; }
  footer a { color:var(--teal); }
`;

// Wspólne: dopisek ?z=nazwa z adresu (np. z kodu QR) trafia do linków do planera i do aplikacji.
const JS_Z = `
const zZAdresu = (new URLSearchParams(location.search).get("z") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
function ustawLinki() {
  document.querySelectorAll("a[data-planer]").forEach((a) => {
    a.href = a.dataset.planer + "?z=" + (zZAdresu || a.dataset.z) + (a.dataset.n ? "#n=" + a.dataset.n : "");
  });
  if (zZAdresu) document.querySelectorAll('a[href*="utm_source=wigilia"]').forEach((a) => {
    a.href = a.href.replace(/utm_content=[a-z0-9_-]+-(logo|stopka)$/, "utm_content=" + zZAdresu + "-$1");
  });
}
ustawLinki();
`;

function strona({ sciezka, tytul, opis, h1, lead, tresc, z, skrypt = "" }) {
  const glebia = sciezka.split("/").filter(Boolean).length;
  const rel = "../".repeat(glebia);
  const app = (co) => `https://welife.world/?utm_source=wigilia&utm_medium=tool&utm_campaign=wigilia-2026&utm_content=${z}-${co}`;
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tytul)}</title>
<meta name="description" content="${esc(opis)}">
<link rel="canonical" href="${BAZA}${sciezka}">
<meta property="og:title" content="${esc(h1)}">
<meta property="og:description" content="${esc(opis)}">
<meta property="og:type" content="article">
<meta property="og:image" content="${BAZA}og.jpg">
<meta property="og:url" content="${BAZA}${sciezka}">
<meta name="theme-color" content="#084E57">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${app("logo")}">WE.LIFE</a><a class="back" href="${rel}" data-planer="${rel}" data-z="${z}">← Planer Wigilii</a>
  <h1>${h1}</h1>
  <p>${lead}</p>
</div></header>
<main class="wrap">
${tresc(rel)}
</main>
<footer><div class="wrap">
  Ilości są orientacyjne: liczone na osobę, gdy na stole jest kilka potraw, i zaokrąglone w górę do ilości, którą da się kupić. Dopasuj je do apetytów w swojej rodzinie.
  Strona nie używa plików cookie i niczego nie zapisuje na serwerze. Przygotowało <a href="${app("stopka")}">WE.LIFE</a>. Stan na ${DZIS.split("-").reverse().join(".")}.
</div></footer>
<script>${JS_Z}${skrypt}</script>
</body>
</html>
`;
}

const wiersze = (poz) => poz.map((p) => `<div class="row"><span>${esc(p.n)}</span><b>${esc(p.ile)}</b></div>`).join("");
const ctaPlaner = (rel, z, n, tekst) => `<div class="cta">
    <h2>Ułóż całą Wigilię, nie tylko jedną potrawę</h2>
    <p>Darmowy planer: lista zakupów na wszystkie potrawy, plan na 3 dni i podział, kto co robi. Bez konta. Wynik wysyłasz rodzinie jednym linkiem.</p>
    <a class="btn" id="cta" href="${rel}?z=${z}#n=${n}" data-planer="${rel}" data-z="${z}" data-n="${n}">${esc(tekst)}</a>
  </div>`;
function inneStrony(rel, pomin) {
  const linki = [
    ...Object.values(POTRAWY).map((p) => [p.slug + "/", p.link]),
    ["lista-zakupow/", "Lista zakupów na Wigilię: 4, 6, 8, 10 i 12 osób"],
    ["plan-przygotowan/", "Plan przygotowań do Wigilii na 3 dni"],
  ].filter(([s]) => s !== pomin);
  return `<section><h2>Inne szybkie odpowiedzi</h2><ul class="links">${linki.map(([s, t]) => `<li><a href="${rel}${s}">${esc(t)}</a></li>`).join("")}</ul></section>`;
}

function stronaPotrawy(id, d, dane) {
  const p = POTRAWY[id];
  const razem = (n) => ile(p.porcja * n, p.jedn);
  const naOsobe = p.jedn === "szt." ? `${p.porcja} sztuk` : p.jedn === "dzwonko" ? "1 dzwonko" : `ok. ${ile(p.porcja, p.jedn)}`;
  const s = d.s;
  const leady = {
    barszcz: () => `Na Wigilię, gdy na stole jest kilka potraw, licz ok. 250 ml barszczu na osobę. Na 6 osób to ${razem(6)}.`,
    uszka: () => `Do barszczu na Wigilię licz 6 uszek na osobę. Na 6 osób to ${p.porcja * 6} sztuk.`,
    pierogi: () => `Na Wigilię, gdy na stole jest kilka potraw, licz 6 pierogów na osobę. Na 6 osób to ${p.porcja * 6} sztuk.`,
    karp: () => `Licz 1 dzwonko karpia na osobę, czyli ok. ${s.karp} g surowej ryby. Na 6 osób to ${d.wg[6].find((x) => x.n.startsWith("Karp")).ile}.`,
    sledzie: () => `Na Wigilię licz ok. 60 g filetów śledziowych na osobę. Na 6 osób to ${razem(6)}.`,
    grecka: () => `Licz ok. 200 g ryby po grecku na osobę: ${s.ryba} g filetu i warzywa. Na 6 osób to ${razem(6)} gotowej potrawy.`,
  };
  const lead = leady[id]();
  const dodatki = {
    barszcz: (rel) => `<section><h2>Ile buraków na barszcz?</h2>
    <p>Planer liczy ${s.buraki} g buraków na porcję 250 ml, czyli ok. ${s.buraki * 4} g buraków na litr barszczu. Na 5 litrów wychodzi ${ile(s.buraki * 20, "g")}.</p>
    <p>Do barszczu podaje się uszka: <a href="${rel}${POTRAWY.uszka.slug}/">6 sztuk na osobę</a>.</p></section>`,
    uszka: (rel) => `<section><h2>Ile uszek na talerz barszczu?</h2>
    <p>6 uszek na jedną porcję barszczu, czyli na ok. 250 ml. Zobacz też: <a href="${rel}${POTRAWY.barszcz.slug}/">ile barszczu na osobę</a>.</p></section>`,
    pierogi: () => `<section><h2>A jeśli pierogi są daniem głównym?</h2>
    <p>Ten przelicznik dotyczy stołu wigilijnego z kilkoma potrawami. Gdy pierogi są jedynym daniem, porcje będą większe.</p></section>`,
    karp: () => `<section><h2>Ile karpia kupić na Wigilię?</h2>
    <p>Na 4 osoby ${d.wg[4].find((x) => x.n.startsWith("Karp")).ile}, na 6 osób ${d.wg[6].find((x) => x.n.startsWith("Karp")).ile}, na 10 osób ${d.wg[10].find((x) => x.n.startsWith("Karp")).ile} karpia w dzwonkach. Ilość jest zaokrąglona w górę do 100 g.</p></section>`,
    sledzie: () => "",
    grecka: () => "",
  };
  const W = Object.fromEntries(WYBOR.map((n) => [n, { ile: razem(n), osob: osob(n), skl: d.wg[n].map((x) => [x.n, x.ile]) }]));
  const skrypt = `
const W = ${JSON.stringify(W)};
const przyciski = document.querySelectorAll(".pick button");
function wybierz(n) {
  const d = W[n]; if (!d) return;
  document.getElementById("ile").textContent = d.ile;
  document.getElementById("nn").textContent = d.osob;
  const skl = document.getElementById("skl"); skl.textContent = "";
  for (const [a, b] of d.skl) {
    const w = document.createElement("div"); w.className = "row";
    const s = document.createElement("span"); s.textContent = a;
    const q = document.createElement("b"); q.textContent = b;
    w.append(s, q); skl.append(w);
  }
  przyciski.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.n === String(n))));
  const cta = document.getElementById("cta"); cta.dataset.n = n; cta.textContent = "Ułóż całą Wigilię na " + d.osob; ustawLinki();
}
przyciski.forEach((b) => b.addEventListener("click", () => wybierz(+b.dataset.n)));
const zHasha = parseInt(new URLSearchParams(location.hash.slice(1)).get("n"), 10);
if (W[zHasha]) wybierz(zHasha);
`;
  const z = "odp-" + id;
  const tresc = (rel) => `
  <section>
    <h2>Wybierz liczbę osób</h2>
    <div class="card">
      <p class="ans" id="ile">${razem(6)}</p>
      <p>${esc(p.czego)} na <span id="nn">${osob(6)}</span> (${naOsobe} na osobę)</p>
      <div class="pick" role="group" aria-label="Liczba osób">${WYBOR.map((n) => `<button type="button" data-n="${n}" aria-pressed="${n === 6}">${n}</button>`).join("")}</div>
      <div class="rows" id="skl">${wiersze(d.wg[6])}</div>
    </div>
    <p class="hint" style="margin-top:10px">Lista pokazuje składniki tej jednej potrawy. Sól, pieprz i przyprawy sprawdź w domu.</p>
  </section>

  <section>
    <h2>Ile ${esc(p.czego)} na 2–40 osób</h2>
    <div class="card tab"><table>
      <thead><tr><th scope="col">Osoby</th><th scope="col">${esc(p.kol)}</th><th scope="col">Składniki do kupienia</th></tr></thead>
      <tbody>${NS.map((n) => `<tr><td class="n">${n}</td><td class="q">${razem(n)}</td><td class="s">${d.wg[n].map((x) => `${esc(x.n.split(" (")[0].split(",")[0].toLowerCase())} ${esc(x.ile)}`).join(", ")}</td></tr>`).join("")}</tbody>
    </table></div>
  </section>
${dodatki[id](rel)}
  <section><h2>Kiedy to zrobić?</h2>
    <div class="card day"><ul>${d.plan.map(([kiedy, co]) => `<li><b>${KIEDY[kiedy]}:</b> ${esc(co)}</li>`).join("")}</ul></div>
  </section>

  ${ctaPlaner(rel, z, 6, "Ułóż całą Wigilię na 6 osób")}
${inneStrony(rel, p.slug + "/")}`;
  const glowny = d.wg[6][0];
  return {
    sciezka: p.slug + "/",
    html: strona({
      sciezka: p.slug + "/", z, skrypt, tresc,
      tytul: `${p.h1} Tabela na 2–40 osób | WE.LIFE`,
      opis: `${lead} Tabela dla 2–40 osób i lista składników, np. ${glowny.n.split(" (")[0].toLowerCase()} ${glowny.ile} na 6 osób.`,
      h1: esc(p.h1), lead: esc(lead),
    }),
  };
}

function planHtml(plan) {
  return plan.map((dz) => `<div class="card day"><h3>${esc(dz.dzien)}<small>${esc(dz.data)}</small></h3><ul>${dz.zadania.map((z) => `<li>${esc(z)}</li>`).join("")}</ul></div>`).join("");
}

function stronaListy(n, dane) {
  const grupy = dane.listy[n];
  const wszystkie = grupy.flatMap((g) => g.poz);
  const znajdz = (pocz) => wszystkie.find((x) => x.n.startsWith(pocz));
  const przyklady = ["Buraki", "Karp", "Kapusta kiszona"].map(znajdz).filter(Boolean).map((x) => `${x.n.split(",")[0].toLowerCase()} ${x.ile}`);
  const z = "odp-lista-" + n;
  const sciezka = slugListy(n);
  const potrawy = dane.domyslne.filter((d) => d.p).map((d) => d.n.split(",")[0].toLowerCase());
  const tresc = (rel) => `
  <section>
    <h2>Lista zakupów na ${osob(n)}</h2>
    <p class="hint">${pozycji(wszystkie.length)}. Ten sam składnik z kilku potraw jest zsumowany.</p>
    <div class="card">${grupy.map((g) => `<div class="group"><h3>${esc(g.nazwa)}</h3>${wiersze(g.poz)}</div>`).join("")}</div>
    <div class="check"><b>Sprawdź, czy masz:</b> ${esc(dane.przyprawy)}.</div>
  </section>

  <section>
    <h2>Ile czego na osobę</h2>
    <div class="card">${dane.domyslne.filter((d) => d.p).map((d) => `<div class="row"><span>${esc(d.n)}</span><b>${esc(d.p.replace(" na osobę", ""))}</b></div>`).join("")}</div>
  </section>

  <section>
    <h2>Plan przygotowań na 3 dni</h2>
    ${planHtml(dane.plan)}
  </section>

  <div class="cta">
    <h2>Inne potrawy albo inna liczba osób?</h2>
    <p>W darmowym planerze zmienisz potrawy, wpiszesz, kto co robi, i wyślesz rodzinie jeden link. Bez konta.</p>
    <a class="btn" href="${rel}?z=${z}#n=${n}" data-planer="${rel}" data-z="${z}" data-n="${n}">Otwórz planer na ${osob(n)}</a>
  </div>

  <section><h2>Inna liczba osób</h2><ul class="links">${LISTY.filter((m) => m !== n).map((m) => `<li><a href="${rel}${slugListy(m)}">Wigilia na ${osob(m)}: lista zakupów</a></li>`).join("")}</ul></section>
${inneStrony(rel, "lista-zakupow/")}`;
  const lead = `${potrawy.length} potraw na ${osob(n)}: ${potrawy.join(", ")}. Poniżej lista zakupów z ilościami i plan na 3 dni.`;
  return {
    sciezka,
    html: strona({
      sciezka, z, tresc,
      tytul: `Wigilia na ${osob(n)}: lista zakupów z ilościami | WE.LIFE`,
      opis: `Lista zakupów na Wigilię dla ${n} osób: ${przyklady.join(", ")} i ${wszystkie.length - przyklady.length} innych pozycji. Do tego plan przygotowań na 3 dni.`,
      h1: `Wigilia na ${osob(n)}: lista zakupów`, lead: esc(lead),
    }),
  };
}

function stronaHub(dane) {
  const z = "odp-lista";
  const tresc = (rel) => `
  <section>
    <h2>Wybierz liczbę osób</h2>
    <ul class="links">${LISTY.map((n) => `<li><a href="${rel}${slugListy(n)}">Wigilia na ${osob(n)}: ${pozycji(dane.listy[n].flatMap((g) => g.poz).length)} z ilościami</a></li>`).join("")}</ul>
  </section>

  <div class="cta">
    <h2>Inna liczba osób albo inne potrawy?</h2>
    <p>Darmowy planer przeliczy listę na 2–30 osób, ułoży plan na 3 dni i podzieli, kto co robi. Bez konta.</p>
    <a class="btn" href="${rel}?z=${z}" data-planer="${rel}" data-z="${z}">Otwórz planer Wigilii</a>
  </div>
${inneStrony(rel, "lista-zakupow/")}`;
  return {
    sciezka: "lista-zakupow/",
    html: strona({
      sciezka: "lista-zakupow/", z, tresc,
      tytul: "Lista zakupów na Wigilię z ilościami: 4, 6, 8, 10 i 12 osób | WE.LIFE",
      opis: "Gotowe listy zakupów na Wigilię z ilościami dla 4, 6, 8, 10 i 12 osób oraz plan przygotowań na 3 dni. Inną liczbę osób przeliczy darmowy planer, bez konta.",
      h1: "Lista zakupów na Wigilię", lead: "Gotowe listy z ilościami dla 4, 6, 8, 10 i 12 osób. Każda liczy te same potrawy i sumuje składniki, które się powtarzają.",
    }),
  };
}

function stronaPlanu(dane) {
  const z = "odp-plan";
  const ileZadan = dane.plan.reduce((a, d) => a + d.zadania.length, 0);
  const tresc = (rel) => `
  <section>
    <h2>${ileZadan} zadań w 3 dni</h2>
    <p class="hint">Plan dla ${dane.domyslne.filter((d) => d.p).length} potraw. Daty dotyczą Wigilii 2026.</p>
    ${planHtml(dane.plan)}
  </section>

  <div class="cta">
    <h2>Podziel te zadania między domowników</h2>
    <p>W darmowym planerze wpiszesz przy każdej potrawie, kto ją robi, dodasz choinkę, prezenty i przywiezienie gości, a plan pokaże zadania z imionami. Bez konta.</p>
    <a class="btn" href="${rel}?z=${z}" data-planer="${rel}" data-z="${z}">Ułóż swój plan</a>
  </div>
${inneStrony(rel, "plan-przygotowan/")}`;
  return {
    sciezka: "plan-przygotowan/",
    html: strona({
      sciezka: "plan-przygotowan/", z, tresc,
      tytul: "Plan przygotowań do Wigilii: co zrobić 2 dni przed, dzień przed i w Wigilię | WE.LIFE",
      opis: `Plan przygotowań do świąt na 3 dni, zadanie po zadaniu: ${ileZadan} zadań od wywaru na barszcz po smażenie karpia. Z darmowym planerem podzielisz je między domowników.`,
      h1: "Plan przygotowań do Wigilii", lead: "Co zrobić 2 dni przed, dzień przed i w samą Wigilię, żeby 24 grudnia zostało tylko to, co musi być świeże.",
    }),
  };
}

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  await page.goto("file://" + PLANER);
  const dane = await page.evaluate(({ ids, ns, listy }) => {
    /* global DANIA, SKL, PRZYPRAWY, stan, zakupy, rysuj */
    const domyslne = DANIA.filter((d) => d.on);
    const czysto = () => { stan.k = {}; stan.s = new Set(); stan.w = []; stan.u = ""; };
    const out = { potrawy: {}, listy: {}, przyprawy: PRZYPRAWY, domyslne: domyslne.map((d) => ({ id: d.id, n: d.n, p: d.p })) };
    for (const id of ids) {
      const d = DANIA.find((x) => x.id === id);
      out.potrawy[id] = { n: d.n, p: d.p, s: d.s, plan: d.plan, wg: {} };
      for (const n of ns) { czysto(); stan.n = n; stan.d = new Set([id]); out.potrawy[id].wg[n] = zakupy("").flatMap((g) => g.poz); }
    }
    for (const n of listy) { czysto(); stan.n = n; stan.d = new Set(domyslne.map((d) => d.id)); out.listy[n] = zakupy(""); }
    czysto(); stan.n = 6; stan.d = new Set(domyslne.map((d) => d.id)); rysuj();
    out.plan = [...document.querySelectorAll("#plan .day")].map((el) => ({
      dzien: el.querySelector("h3").childNodes[0].textContent.trim(),
      data: el.querySelector("h3 small").textContent.trim(),
      zadania: [...el.querySelectorAll("li")].map((li) => li.textContent.trim()),
    }));
    return out;
  }, { ids: Object.keys(POTRAWY), ns: NS, listy: LISTY });
  await b.close();

  // Bezpieczniki: porcja w tym pliku musi zgadzać się z opisem porcji w planerze, a WYBOR musi być podzbiorem NS.
  for (const [id, p] of Object.entries(POTRAWY)) {
    const opis = dane.potrawy[id].p;
    if (!new RegExp(`(^|\\D)${p.porcja}(\\D|$)`).test(opis)) throw new Error(`Porcja ${id}: tutaj ${p.porcja}, w planerze „${opis}”. Popraw POTRAWY.`);
  }
  if (!WYBOR.every((n) => NS.includes(n)) || !LISTY.every((n) => NS.includes(n))) throw new Error("WYBOR i LISTY muszą zawierać się w NS.");

  const strony = [
    ...Object.keys(POTRAWY).map((id) => stronaPotrawy(id, dane.potrawy[id], dane)),
    stronaHub(dane),
    ...LISTY.map((n) => stronaListy(n, dane)),
    stronaPlanu(dane),
  ];
  for (const s of strony) {
    const plik = path.join(SITE, "wigilia", s.sciezka, "index.html");
    fs.mkdirSync(path.dirname(plik), { recursive: true });
    fs.writeFileSync(plik, s.html);
  }
  const adresy = [BAZA, ...strony.map((s) => BAZA + s.sciezka)];
  fs.writeFileSync(path.join(SITE, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${adresy.map((u) => `  <url><loc>${u}</loc><lastmod>${DZIS}</lastmod></url>`).join("\n")}
</urlset>
`);
  fs.writeFileSync(path.join(SITE, "wigilia/odpowiedzi.json"), JSON.stringify({ wygenerowano: DZIS, baza: BAZA, strony: strony.map((s) => s.sciezka) }, null, 2) + "\n");
  console.log(`zapisano ${strony.length} stron:`);
  for (const s of strony) console.log("  " + BAZA + s.sciezka);
  console.log("barszcz na 6 osób:", JSON.stringify(dane.potrawy.barszcz.wg[6]));
})();
