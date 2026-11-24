#!/usr/bin/env python3
"""Dane do „Planu tygodnia” (site/tydzien/): wybrane obiady z katalogu WE.LIFE z uporządkowanymi składnikami.

  python3 narzedzia/plan-tygodnia-dane.py [ścieżka do repo welife-app]

Czyta data/recipe-budget-estimates/20260920/canonical.json (ilości na 1 porcję) i zdjęcia public/cook/heroes/.
Zapisuje site/tydzien/dane.js i miniatury site/tydzien/foto/<id>.webp.

Każdy składnik wybranych dań musi mieć wpis w tabeli SKLADNIKI. Nieznana nazwa albo jednostka przerywa pracę,
żeby na liście zakupów nie znalazło się nic przeliczonego „na oko” bez wiedzy autora.
"""
import collections
import json
import os
import re
import sys

from PIL import Image

APP = (sys.argv[1] if len(sys.argv) > 1 else "/home/user/welife-app").rstrip("/") + "/"
TU = os.path.dirname(os.path.abspath(__file__))
WYJ = os.path.join(TU, "../site/tydzien/")

# Wybrane obiady: skrót identyfikatora przepisu → rodzaj (m = mięso, r = ryba, w = bez mięsa). Kolejność = kolejność w wyborze.
DANIA = [
    ("07bda1a8", "m"), ("1922e788", "m"), ("3633daa1", "m"), ("0b6fa12f", "m"), ("59965798", "m"), ("127b903c", "m"), ("91b4e904", "m"),
    ("6decbd81", "m"), ("101f095f", "m"), ("c4e960bf", "m"), ("9d11883a", "m"), ("4d937059", "m"), ("60ddf9f6", "m"), ("893bdeac", "m"), ("fc81d94d", "m"),
    ("88c56ef6", "r"), ("c4462e3b", "r"), ("9e860d8b", "r"), ("b904c450", "r"), ("5533ddfb", "r"),
    ("54fec575", "w"), ("b92290f1", "w"), ("4d8a4e19", "w"), ("c3132fa8", "w"), ("684a60a6", "w"), ("2826a4b8", "w"), ("31fd65e4", "w"),
    ("de855890", "w"), ("dd116a06", "w"), ("e5003f2c", "w"), ("eff482a6", "w"), ("7e721a4a", "w"),
]
NAZWY = {"1922e788": "Kurczak curry z ryżem"}  # poprawka literówki w danych („ryzem”)
DOMYSLNE = ["07bda1a8", "54fec575", "6decbd81", "4d8a4e19", "88c56ef6"]  # pon.–pt.: drób, makaron, indyk z kaszą, soczewica, ryba

SEKCJE = ["Warzywa i owoce", "Mięso i wędliny", "Ryby", "Nabiał i jajka", "Makaron, ryż, kasze", "Puszki i słoiki", "Tłuszcze", "Pieczywo"]
W, M, R, N, S, P, T, C = range(8)

# nazwa w danych → (klucz, nazwa na liście, sekcja, jednostka na liście, przeliczenia {jednostka w danych: mnożnik})
# Jednostki na liście: g, ml, szt, zabek, puszka oraz doniczka i peczek (świeże zioła: zawsze 1 sztuka, bez mnożenia przez porcje).
SZT = {"szt": 1, "sztuka": 1}
SKLADNIKI = {
    "Bazylia": ("bazylia", "Bazylia świeża", W, "doniczka", {"g": 0}),
    "Natka pietruszki": ("natka", "Natka pietruszki", W, "peczek", {"g": 0, "lyzka": 0}),
    "Brokuł": ("brokul", "Brokuł", W, "g", {"g": 1}),
    "Cebula": ("cebula", "Cebula", W, "szt", SZT),
    "Cukinia": ("cukinia", "Cukinia", W, "szt", {**SZT, "g": 1 / 300}),  # średnia cukinia ok. 300 g
    "Czosnek": ("czosnek", "Czosnek", W, "zabek", {"szt": 1, "ząbek": 1}),  # w danych „szt.” czosnku to ząbek (tak mówią kroki przepisów)
    "Dynia": ("dynia", "Dynia", W, "g", {"g": 1}),
    "Imbir": ("imbir", "Imbir świeży", W, "g", {"g": 1}),
    "Kalafior": ("kalafior", "Kalafior", W, "g", {"g": 1}),
    "Kapusta": ("kapusta", "Kapusta biała", W, "g", {"g": 1}),
    "Marchew": ("marchew", "Marchew", W, "szt", SZT),
    "Ogórek": ("ogorek", "Ogórek", W, "szt", {**SZT, "g": 1 / 180}),  # średni ogórek ok. 180 g
    "Papryka": ("papryka", "Papryka", W, "szt", SZT),
    "Pieczarki": ("pieczarki", "Pieczarki", W, "g", {"g": 1}),
    "Pomidor": ("pomidor", "Pomidor", W, "szt", SZT),
    "Pomidorki koktajlowe": ("pomidorki", "Pomidorki koktajlowe", W, "g", {"g": 1}),
    "Sałata": ("salata", "Sałata", W, "g", {"g": 1}),
    "Szpinak świeży": ("szpinak", "Szpinak świeży", W, "g", {"g": 1}),
    "Ziemniaki": ("ziemniaki", "Ziemniaki", W, "g", {"g": 1}),
    "Mieszanka warzyw": ("mieszanka", "Mieszanka warzyw (może być mrożona)", W, "g", {"g": 1}),
    "Filet z kurczaka": ("kurczak", "Filet z piersi kurczaka", M, "g", {"g": 1}),
    "Pierś z kurczaka": ("kurczak", "Filet z piersi kurczaka", M, "g", {"g": 1}),
    "Udka z kurczaka": ("udka", "Udka z kurczaka", M, "g", {"g": 1}),
    "Filet z indyka": ("indyk", "Filet z indyka", M, "g", {"g": 1}),
    "Mielona indyka": ("mielone-indyk", "Mięso mielone z indyka", M, "g", {"g": 1}),
    "Mięso mielone wołowo-wieprzowe": ("mielone", "Mięso mielone wołowo-wieprzowe", M, "g", {"g": 1}),
    "Schab wieprzowy": ("schab", "Schab wieprzowy", M, "g", {"g": 1}),
    "Wołowina (łopatka)": ("wolowina", "Wołowina (łopatka)", M, "g", {"g": 1}),
    "Stek wołowy (antrykot)": ("antrykot", "Stek wołowy (antrykot)", M, "g", {"g": 1}),
    "Kiełbasa": ("kielbasa", "Kiełbasa", M, "g", {"g": 1}),
    "Filet z dorsza": ("dorsz", "Filet z dorsza", R, "g", {"g": 1}),
    "Filet z łososia": ("losos", "Filet z łososia", R, "g", {"g": 1}),
    "Łosoś": ("losos", "Filet z łososia", R, "g", {"g": 1}),
    "Makrela": ("makrela", "Makrela świeża", R, "g", {"g": 1}),
    "Tuńczyk w sosie własnym": ("tunczyk", "Tuńczyk w sosie własnym", R, "puszka", {"puszka": 1}),
    "Jajka": ("jajka", "Jajka", N, "szt", SZT),
    "Jajko": ("jajka", "Jajka", N, "szt", SZT),
    "Jogurt naturalny": ("jogurt", "Jogurt naturalny", N, "g", {"g": 1}),
    "Mascarpone": ("mascarpone", "Mascarpone", N, "g", {"g": 1}),
    "Masło": ("maslo", "Masło", N, "g", {"g": 1}),
    "Masło klarowane": ("maslo-klarowane", "Masło klarowane", N, "g", {"g": 1}),
    "Mleko": ("mleko", "Mleko", N, "ml", {"ml": 1}),
    "Ser żółty": ("ser", "Ser żółty", N, "g", {"g": 1}),
    "Twaróg": ("twarog", "Twaróg", N, "g", {"g": 1}),
    "Śmietana 30%": ("smietanka", "Śmietanka 30%", N, "ml", {"ml": 1}),
    "Makaron": ("makaron", "Makaron", S, "g", {"g": 1}),
    "Makaron spaghetti": ("spaghetti", "Makaron spaghetti", S, "g", {"g": 1}),
    "Ryż": ("ryz", "Ryż biały", S, "g", {"g": 1}),
    "Ryż biały": ("ryz", "Ryż biały", S, "g", {"g": 1}),
    "Kasza gryczana": ("gryczana", "Kasza gryczana", S, "g", {"g": 1}),
    "Kasza pęczak": ("peczak", "Kasza pęczak", S, "g", {"g": 1}),
    "Mąka": ("maka", "Mąka pszenna", S, "g", {"g": 1}),
    "Soczewica czerwona": ("soczewica", "Soczewica czerwona", S, "g", {"g": 1}),
    "Passata pomidorowa": ("passata", "Passata pomidorowa", P, "g", {"g": 1}),
    "Pomidory z puszki": ("pomidory-puszka", "Pomidory z puszki", P, "g", {"g": 1}),
    "Przecier pomidorowy": ("przecier", "Przecier pomidorowy", P, "g", {"g": 1}),
    "Kukurydza": ("kukurydza", "Kukurydza konserwowa", P, "g", {"g": 1}),
    "Ciecierzyca": ("ciecierzyca", "Ciecierzyca (z puszki albo słoika)", P, "g", {"g": 1}),
    "Mleko kokosowe": ("kokosowe", "Mleko kokosowe", P, "ml", {"ml": 1}),
    "Sos sojowy": ("sojowy", "Sos sojowy", P, "ml", {"ml": 1}),
    "Bulion": ("bulion", "Bulion warzywny", P, "ml", {"ml": 1}),
    "Oliwa z oliwek": ("oliwa", "Oliwa z oliwek", T, "ml", {"ml": 1, "lyzka": 15}),  # łyżka = 15 ml
    "Olej rzepakowy": ("olej", "Olej rzepakowy", T, "ml", {"ml": 1, "lyzka": 15}),
    "Tofu": ("tofu", "Tofu naturalne", N, "g", {"g": 1}),
    "Tortilla": ("tortilla", "Tortilla pszenna", C, "szt", SZT),
}
# Przyprawy i dodatki, których nie liczymy: trafiają do „Sprawdź, czy masz”.
W_DOMU = {
    "Sól": ["sól"], "Sól i pieprz": ["sól", "pieprz"], "Tymianek": ["tymianek"], "Curry": ["przyprawa curry"],
    "Papryka słodka mielona": ["papryka słodka mielona"], "Pieprz w ziarnach": ["pieprz"],
}

d = json.load(open(APP + "data/recipe-budget-estimates/20260920/canonical.json", encoding="utf-8"))
przepisy = {r["id"][:8]: r for r in d["recipes"]}
assert len(przepisy) == len(d["recipes"]), "skrócone identyfikatory przepisów nie są unikalne"
skladniki = collections.defaultdict(list)
for i in d["recipeIngredients"]:
    skladniki[i["recipe_id"]].append(i)

os.makedirs(WYJ + "foto", exist_ok=True)
dania, uzyte = [], {}
for k, rodzaj in DANIA:
    r = przepisy[k]
    assert r["visibility"] == "public" and r["lifecycle"] == "active", k
    skl, dom = collections.OrderedDict(), []
    for i in sorted(skladniki[r["id"]], key=lambda i: i["sort_order"] or 0):
        nazwa, jedn = i["name"], i["unit"]
        if nazwa in W_DOMU:
            dom += [x for x in W_DOMU[nazwa] if x not in dom]
            continue
        if nazwa not in SKLADNIKI:
            raise SystemExit(f"Nieznany składnik „{nazwa}” ({jedn}) w przepisie {k} {r['name']}: dopisz go do SKLADNIKI albo W_DOMU.")
        klucz, etykieta, sekcja, cel, przel = SKLADNIKI[nazwa]
        if jedn not in przel:
            raise SystemExit(f"Nieznana jednostka „{jedn}” dla „{nazwa}” w przepisie {k} {r['name']}: dopisz przeliczenie.")
        uzyte[klucz] = [etykieta, sekcja, cel]
        skl[klucz] = 1 if cel in ("doniczka", "peczek") else round(skl.get(klucz, 0) + i["amount"] * przel[jedn], 4)
    kroki = [re.sub(r"^\d+\.\s*", "", x).strip() for x in (r["instructions"] or "").split("\n") if x.strip()]
    assert len(kroki) >= 2, (k, "za mało kroków")
    czas = (r.get("prep_time_min") or 0) + (r.get("cook_time_min") or 0)
    assert czas > 0, k
    im = Image.open(APP + f"public/cook/heroes/{r['id']}.webp").convert("RGB")
    bok = min(im.size)
    im.crop(((im.width - bok) // 2, (im.height - bok) // 2, (im.width + bok) // 2, (im.height + bok) // 2)).resize((360, 360), Image.LANCZOS).save(WYJ + f"foto/{k}.webp", quality=76, method=6)
    dania.append({"id": k, "pelne": r["id"], "n": NAZWY.get(k, r["name"]), "r": rodzaj, "t": czas, "kcal": r["calories"], "b": r["protein_g"], "tl": r["fat_g"], "wg": r["carbs_g"],
                  "s": [[kl, il] for kl, il in skl.items()], "dom": dom, "kroki": kroki})

assert all(x in {k for k, _ in DANIA} for x in DOMYSLNE)
dane = {"sekcje": SEKCJE, "skladniki": uzyte, "dania": dania, "domyslne": DOMYSLNE, "zrodlo": "canonical.json z 20.09.2026, ilości na 1 porcję"}
open(WYJ + "dane.js", "w", encoding="utf-8").write("// Plik generowany przez narzedzia/plan-tygodnia-dane.py. Nie edytuj ręcznie.\nconst DANE = " + json.dumps(dane, ensure_ascii=False, separators=(",", ":")) + ";\n")
print(f"dań: {len(dania)} | składników na listach: {len(uzyte)} | dane.js: {os.path.getsize(WYJ + 'dane.js') // 1024} kB | miniatury: {sum(os.path.getsize(WYJ + 'foto/' + f) for f in os.listdir(WYJ + 'foto')) // 1024} kB")
for x in dania:
    print(f"  {x['id']} {x['r']} {x['t']:>3} min {x['kcal']} kcal | {x['n']} | " + ", ".join(f"{uzyte[k][0]} {il:g} {uzyte[k][2]}" for k, il in x["s"]) + (" | w domu: " + ", ".join(x["dom"]) if x["dom"] else ""))
