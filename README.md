# welife-social

Kolejka gotowych postów WE.LIFE i automat, który publikuje je o zaplanowanych godzinach
na Instagramie (@welife.world) i stronie WE.LIFE na Facebooku. Działa przez **oficjalne API Meta**
(Instagram Graph API + Pages API) w GitHub Actions. Nie używa botów ani logowania na konto.

Strategia, plany i szablony wiadomości są w prywatnym repo `welife-app` (`marketing/`).
Tutaj trafiają tylko rzeczy, które i tak zaraz będą publiczne: gotowe posty i ich pliki.

> **Domyślnie automat działa w trybie próbnym**: co 10 minut sprawdza kolejkę i wypisuje w logu,
> co by opublikował, ale niczego nie wysyła. Publikuje dopiero po ustawieniu zmiennej `PUBLISH_LIVE=true`.

## Jak to działa

```
queue/*.json  ──►  GitHub Actions „Publikacja” (co 10 min)  ──►  Instagram + strona FB
media/*       ──►  publiczny adres (jsDelivr z tego repo)   ──►  Meta pobiera pliki stąd
state/published.json  ◄──  zapis: co, gdzie i kiedy wyszło (nic nie wychodzi dwa razy)
```

Bezpieczniki w `scripts/lib.mjs` (post nie wyjdzie, jeśli):

- tekst nie mówi, że WE.LIFE to **wersja beta** (zasada właściciela);
- tekst zawiera niewypełnione pole `{{…}}`;
- post ma obrazy AI (`"ai_imagery": true`), a tekst nie mówi o AI;
- na Instagramie jest więcej niż 5 hashtagów albo zdjęcie nie jest JPEG;
- plik nie odpowiada pod publicznym adresem;
- termin minął ponad 24 h temu (np. automat był wyłączony); wtedy post jest pomijany, nie wysyłany z opóźnieniem.

Błąd API → ponowienie w kolejnym przebiegu, po 3 próbach status `failed` i czerwony przebieg (e-mail z GitHuba).

## Uruchomienie (raz, ok. 20 minut)

### 1. Strona FB połączona z Instagramem

Meta Business Suite → Ustawienia → Konta → Konta na Instagramie → połącz `@welife.world` ze stroną WE.LIFE.
Konto IG musi być kontem **profesjonalnym** (Firma).

### 2. Aplikacja Meta i token (polecane: użytkownik systemowy, token bez wygaśnięcia)

1. https://developers.facebook.com/apps → **Utwórz aplikację** → typ **Firma (Business)**,
   przypisz ją do portfolio firmowego, w którym jest strona WE.LIFE.
2. W aplikacji dodaj produkt **Instagram** (wariant „API setup with Facebook login”).
3. https://business.facebook.com/settings → **Użytkownicy systemowi** → Dodaj (rola Administrator).
4. Przy użytkowniku systemowym: **Przypisz zasoby** → strona WE.LIFE (pełna kontrola),
   konto Instagram `@welife.world`, aplikacja z punktu 1.
5. **Wygeneruj nowy token** → aplikacja z punktu 1 → wygaśnięcie: **Nigdy** → uprawnienia:
   `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `business_management`. Skopiuj token (pokazuje się raz).

Szybsza alternatywa na test: Graph API Explorer → token użytkownika z tymi uprawnieniami →
„Extend Access Token” w Access Token Debugger (ważny 60 dni; workflow „Sprawdź konfigurację”
ostrzeże 10 dni przed końcem).

Jeśli Meta poprosi o weryfikację firmy albo App Review, zatrzymaj się i napisz do Claude:
to zależy od konta, a automat poczeka w trybie próbnym.

### 3. Sekrety w tym repo

Settings → Secrets and variables → Actions → **Secrets** → New repository secret:

| nazwa | wartość |
| --- | --- |
| `META_ACCESS_TOKEN` | token z kroku 2 |
| `FB_PAGE_ID` | ID strony WE.LIFE (Strona → Informacje / Ustawienia → Przejrzystość strony) |
| `IG_USER_ID` | ID konta IG; jeśli nie wiesz, zostaw puste i uruchom krok 4 |

### 4. Sprawdzenie

Actions → **Sprawdź konfigurację** → Run workflow. Log pokaże ważność tokenu, uprawnienia,
nazwę strony i połączone konto IG z jego ID (wpisz je jako `IG_USER_ID`, jeśli brakowało).
Zielony przebieg = gotowe.

Potem Actions → **Publikacja** → Run workflow i przeczytaj log trybu próbnego.

### 5. Włączenie publikacji

Settings → Secrets and variables → Actions → **Variables** → New repository variable:
`PUBLISH_LIVE` = `true`. Wyłączenie: zmień na `false` albo usuń zmienną.

## Dodawanie postów

Jeden plik na post w `queue/` (nazwa = id), pliki w `media/`. Przykład rolki:

```json
{
  "id": "2026-11-02-r1",
  "publish_at": "2026-11-02T18:30:00+01:00",
  "platforms": ["instagram", "facebook"],
  "type": "reel",
  "media": ["media/R1.mp4"],
  "cover": "media/R1-cover.jpg",
  "ai_imagery": true,
  "caption": "… wersja beta … AI … #planposiłków"
}
```

| pole | znaczenie |
| --- | --- |
| `publish_at` | czas z przesunięciem strefy (`+01:00` zimą, `+02:00` latem w Polsce) |
| `platforms` | `instagram` i/lub `facebook` |
| `type` | `reel` (MP4), `carousel` (2–10 JPEG), `image` (JPEG), `text` (tylko FB) |
| `facebook.message` | inny tekst na FB (domyślnie `caption`) |
| `facebook.link` | link z podglądem w poście FB |
| `force` | `true` = opublikuj mimo terminu sprzed ponad 24 h |

Po pushu workflow **Testy** sprawdza całą kolejkę. Rolki i karuzele generuje `welife-app`
(`marketing/instagram/tools/reel.mjs`, `render.mjs`); Claude może dopisywać tu kolejne posty.

## Czego API nie zrobi (zostaje ręcznie)

- **Przypięcie posta** na profilu IG.
- **Muzyka z biblioteki Instagrama**: rolki z API wychodzą z dźwiękiem z pliku (tu: cisza).
- **Przełącznik „Etykieta AI”**: zamiast niego tekst każdego posta z obrazami AI mówi o tym wprost
  (bezpiecznik `ai_imagery`). Po publikacji możesz dodatkowo włączyć etykietę w edycji posta, jeśli aplikacja ją pokazuje.
- Odpowiedzi na komentarze i wiadomości (PLAN) obsługujesz w Meta Business Suite.

## Uwagi

- GitHub uruchamia harmonogram z opóźnieniem do kilkunastu minut. Post z 18:30 wyjdzie ok. 18:30–18:50.
- Limit Meta: 50 postów przez API na dobę na konto IG. Ten plan to kilka tygodniowo.
- GitHub wyłącza harmonogram w repo bez aktywności przez 60 dni. Każdy nowy post w kolejce to aktywność.
- Repo jest publiczne: **nigdy nie wpisuj tokenu do plików**, tylko do sekretów.
