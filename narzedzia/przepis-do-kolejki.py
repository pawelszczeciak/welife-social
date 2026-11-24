#!/usr/bin/env python3
"""Odświeża w kolejce rolki-przepisy (seria P) po ponownym zbudowaniu ich w welife-app.

  python3 narzedzia/przepis-do-kolejki.py <katalog z Pnn.mp4 i Pnn-okladka.jpg> P03 P05 ... [--app /ścieżka/do/welife-app]

Dla każdego kodu znajduje wpis queue/*-pNN.json, podmienia film i okładkę w media/ oraz opis, tekst na Facebooka
i pin na te z marketing/instagram/rolki/przepisy/Pnn.opis.json. Dat, platform i identyfikatorów nie rusza.
Wpisu już opublikowanego (klucz w state/published.json) nie zmienia.
"""
import glob
import json
import os
import shutil
import sys

args = sys.argv[1:]
app = "/home/user/welife-app"
if "--app" in args:
    app = args.pop(args.index("--app") + 1)
    args.remove("--app")
src, kody = args[0], args[1:]
tu = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(tu, ".."))
opublikowane = json.load(open(os.path.join(repo, "state/published.json"), encoding="utf-8"))

for kod in kody:
    pliki = glob.glob(os.path.join(repo, f"queue/*-{kod.lower()}.json"))
    if len(pliki) != 1:
        raise SystemExit(f"{kod}: oczekiwano jednego wpisu w kolejce, jest {len(pliki)}")
    q = json.load(open(pliki[0], encoding="utf-8"))
    if any(k.startswith(q["id"] + ":") for k in opublikowane):
        raise SystemExit(f"{kod}: wpis {q['id']} jest już opublikowany, nie zmieniam go")
    film, okladka = os.path.join(src, f"{kod}.mp4"), os.path.join(src, f"{kod}-okladka.jpg")
    for p in (film, okladka):
        if not os.path.getsize(p):
            raise SystemExit(f"{kod}: pusty plik {p}")
    o = json.load(open(os.path.join(app, f"marketing/instagram/rolki/przepisy/{kod}.opis.json"), encoding="utf-8"))
    if q["media"] != [f"media/{kod}.mp4"] or q["cover"] != f"media/{kod}-cover.jpg":
        raise SystemExit(f"{kod}: wpis wskazuje inne pliki niż media/{kod}.mp4 i media/{kod}-cover.jpg")
    shutil.copyfile(film, os.path.join(repo, q["media"][0]))
    shutil.copyfile(okladka, os.path.join(repo, q["cover"]))
    q["caption"] = o["caption"]
    q["facebook"]["message"] = o["facebook_message"].replace("{id}", q["id"])
    q["pinterest"]["title"] = o["pinterest"]["title"]
    q["pinterest"]["description"] = o["pinterest"]["description"]
    open(pliki[0], "w", encoding="utf-8").write(json.dumps(q, ensure_ascii=False, indent=2) + "\n")
    print(f"{kod}: {os.path.basename(pliki[0])} | {q['publish_at']} | {q['caption'].splitlines()[0]}")
