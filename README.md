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

### 1. Portfolio firmowe ze stroną i Instagramem

1. Wejdź na https://business.facebook.com i zaloguj się kontem FB, które zarządza stroną WE.LIFE.
   Jeśli nie masz portfolio firmowego, utwórz je: nazwa `WE.LIFE`, Twoje imię i nazwisko, e-mail firmowy.
2. https://business.facebook.com/settings → **Konta → Strony** → Dodaj → Dodaj stronę → `WE.LIFE`.
3. **Konta → Konta na Instagramie** → Dodaj → zaloguj się na `@welife.world` (konto musi być profesjonalne, typ Firma).
4. Połącz stronę z Instagramem: w aplikacji Instagram → Edytuj profil → **Strona** → Połącz istniejącą stronę → `WE.LIFE`
   (albo w Meta Business Suite → Ustawienia → Konta na Instagramie → Połącz).

### 2. Aplikacja Meta

1. https://developers.facebook.com → zaloguj się tym samym kontem FB. Za pierwszym razem: **Zacznij**,
   zaakceptuj warunki i potwierdź telefon lub e-mail.
2. **Moje aplikacje → Utwórz aplikację**. Przypadek użycia: **Inne**. Typ aplikacji: **Firma** (Business).
   Nazwa: `WE.LIFE Publisher`, e-mail kontaktowy, portfolio firmowe: `WE.LIFE`.
3. W panelu aplikacji → **Dodaj produkt** → **Instagram** → Skonfiguruj → wariant
   **„API setup with Facebook login”** (logowanie przez Facebooka).
4. Tryb aplikacji zostaw na razie **W trakcie tworzenia**. Jeśli później publikacja zwróci błąd uprawnień,
   przełącz na **Na żywo**: Ustawienia aplikacji → Podstawowe → URL polityki prywatności
   `https://welife.world/privacy`, kategoria, ikona (`profil-1080.png`) → przełącznik trybu u góry.

### 3. Użytkownik systemowy i token bez wygaśnięcia

1. https://business.facebook.com/settings → **Użytkownicy → Użytkownicy systemowi** → Dodaj.
   Nazwa: `welife-publisher`, rola: **Administrator**.
2. Przy użytkowniku systemowym → **Przypisz zasoby**:
   - Strony → `WE.LIFE` → pełna kontrola;
   - Konta na Instagramie → `@welife.world` → pełna kontrola;
   - Aplikacje → `WE.LIFE Publisher` → zarządzanie aplikacją.
3. **Wygeneruj nowy token** → aplikacja `WE.LIFE Publisher` → wygaśnięcie: **Nigdy** → uprawnienia:
   `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `business_management` → Wygeneruj.
4. Skopiuj token od razu (pokazuje się raz) i zapisz w menedżerze haseł.
   **Nie wklejaj go do czatu, maila ani plików w repo.**

Szybsza alternatywa na test: Graph API Explorer → token użytkownika z tymi uprawnieniami →
„Extend Access Token” w Access Token Debugger (ważny 60 dni; workflow „Sprawdź konfigurację”
ostrzeże 10 dni przed końcem).

Jeśli Meta poprosi o weryfikację firmy albo App Review, zatrzymaj się: automat poczeka w trybie próbnym.

### 4. Sekrety w tym repo

https://github.com/pawelszczeciak/welife-social/settings/secrets/actions → **New repository secret**:

| nazwa | wartość |
| --- | --- |
| `META_ACCESS_TOKEN` | token z kroku 3 |
| `FB_PAGE_ID` | ID strony: Facebook → strona WE.LIFE → Informacje → Przejrzystość strony → Identyfikator strony |
| `IG_USER_ID` | ID konta IG; jeśli nie wiesz, pomiń i wykonaj krok 5 |

### 5. Sprawdzenie

https://github.com/pawelszczeciak/welife-social/actions → **Sprawdź konfigurację** → Run workflow → otwórz log.
Pokaże ważność tokenu, brakujące uprawnienia, nazwę strony i ID połączonego konta IG.
Wpisz to ID jako sekret `IG_USER_ID` i uruchom ponownie. Zielony przebieg = gotowe.

Potem **Publikacja** → Run workflow: log trybu próbnego pokaże, co i kiedy wyjdzie.

### 6. Włączenie publikacji

Settings → Secrets and variables → Actions → zakładka **Variables** → New repository variable:
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
