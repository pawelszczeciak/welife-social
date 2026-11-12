# welife-social

Kolejka gotowych postów WE.LIFE i automat, który publikuje je o zaplanowanych godzinach
na Instagramie (@welife.world), stronie WE.LIFE na Facebooku i opcjonalnie na TikToku (sekcja „TikTok”). Działa przez **oficjalne API** (Meta, TikTok)
(Instagram Graph API, Pages API, TikTok Content Posting API) w GitHub Actions. Nie używa botów ani logowania na konto.

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
- rolka nie ma dźwięku (brak ścieżki audio albo cisza, poniżej 16 kb/s); dźwięku nie da się dodać po publikacji;
- plik nie odpowiada pod publicznym adresem;
- termin minął ponad 24 h temu (np. automat był wyłączony); wtedy post jest pomijany, nie wysyłany z opóźnieniem.

Błąd API → ponowienie w kolejnym przebiegu, po 3 próbach status `failed` i czerwony przebieg (e-mail z GitHuba).
Błąd limitu zapytań Meta (np. „Application request limit reached”) → kolejna próba najwcześniej po 60 min
(`RATE_LIMIT_BACKOFF_MINUTES`, 0–1440; dłużej, jeśli Meta poda szacowany czas odblokowania). To okno
bezpieczeństwa, nie gwarancja odnowienia każdego limitu.
Błąd Instagrama nie dowodzi, że post nie wyszedł (K4 PL: 3 kopie przy statusie `failed`). Dlatego:
kontener jest zapisywany na dysk przed `media_publish`, a id posta zaraz po nim; kolejna próba najpierw sprawdza
stan kontenera i ostatnie posty konta. Post z identycznym opisem od czasu kontenera = zapis jako opublikowany.
Ponowna publikacja tylko przy rozstrzygającym braku posta i kontenerze `FINISHED` (ten sam) albo `EXPIRED` (nowy);
`IN_PROGRESS` czeka, a wszystko niepewne (inny status, lista bez dojścia do daty, post bez id/czasu) kończy się
statusem `failed` do sprawdzenia ręcznego, bez publikacji. Przed pierwszą publikacją IG automat też sprawdza, czy
post z tym opisem nie wyszedł już od terminu (np. gdy stan poprzedniego przebiegu nie został wypchnięty).

Ręczne wznowienie pozycji `failed`: `scripts/requeue.mjs` (tylko po sprawdzeniu, że posta nie ma na platformie).
Post widoczny na platformie mimo `failed`: `scripts/reconcile.mjs <post:platforma> --id <id> [--duplicate <id>]`
zapisuje jego id (bez publikowania i usuwania). Oba domyślnie w trybie próby, zapis wymaga `--apply --expect-sha256`.
Workflow „Diagnostyka Meta” (ręczny, tylko odczyty Graph API, bez TikToka/Zernio i bez zapisu do repo) pokazuje
limit publikacji IG, zużycie limitów Meta, posty IG z identycznym opisem i to, czy pozycje IG `failed`/`retry`
nie są jednak na koncie; niepewny lub nieudany odczyt to błąd przebiegu, nie dowód nieobecności. „Sprawdź
konfigurację” robi to samo, ale dodatkowo sprawdza TikToka (bezpośrednie API może przy tym odświeżyć token).

Status `removed` w `state/published.json` = publikacja usunięta z platformy (np. podmieniona na wersję z dźwiękiem);
automat nie publikuje jej ponownie. Duplikaty z Facebooka usuwa ręcznie uruchamiany workflow „Usuń posty z Facebooka”
(nie rusza wpisów o statusie `published`). Instagram i TikTok nie pozwalają usuwać filmów przez API.

## YouTube Shorts

Rolki z `"youtube"` w `platforms` idą też na YouTube przez Zernio (ten sam klucz `ZERNIO_API_KEY`, YouTube mieści się
w 2 darmowych kontach Zernio razem z TikTokiem). Pionowy film do 3 minut YouTube sam uznaje za Short.

- **Włączenie:** w Zernio podłącz kanał YouTube (Accounts → Connect → YouTube). Nic więcej: automat sam znajdzie kanał.
  Dopóki kanału nie ma, rolki na YouTube są pomijane bez błędu (log „POMINIĘTE … nie ma podłączonego kanału YouTube”),
  a po 24 h dana rolka nie jest już nadrabiana.
- **Co wychodzi:** tytuł = pierwsza linia opisu (do 100 znaków) albo `youtube.title`; opis = opis posta, w którym
  „w bio @welife.world” zamienia się na „na welife.world”, plus link `…?utm_source=youtube&utm_campaign=<id>`
  (albo własny `youtube.description`); okładka jako miniatura; film publiczny, nie „dla dzieci”, kategoria Howto & Style;
  przy `ai_imagery` zgłoszone treści syntetyczne (YouTube może dodać etykietę).
- Zmienne opcjonalne: `YOUTUBE_VISIBILITY` (`public`/`unlisted`/`private`), `YOUTUBE_CATEGORY_ID`,
  sekret `ZERNIO_YOUTUBE_ACCOUNT_ID` (tylko gdy w Zernio są dwa kanały).

## Pinterest

Posty i rolki z `"pinterest"` w `platforms` wychodzą jako piny przez Zernio. Pin ma **klikalny link** prosto do
`welife.world` (z `utm_source=pinterest&utm_campaign=<id>`), czego nie ma Instagram ani TikTok. W Zernio to trzecie
konto, czyli 6 USD miesięcznie (dwa pierwsze są darmowe).

- **Włączenie:** załóż konto firmowe na Pintereście, podłącz je w Zernio (Accounts → Connect → Pinterest). Dopóki
  konta nie ma, piny są pomijane bez błędu.
- **Tablica:** automat używa tablicy „Plan posiłków” (albo `PINTEREST_BOARD_NAME` / `PINTEREST_BOARD_ID` w zmiennych
  repo). Jeśli jej nie ma, zakłada ją publicznie przy pierwszym pinie.
- **Co wychodzi:** karta = pin obrazkowy; karuzela = jeden slajd (`pinterest.media` albo pierwszy), bo Pinterest
  nie ma karuzel przez API; rolka = pin wideo z okładką. Tytuł i opis najlepiej podać wprost w `pinterest.title`
  (do 100 znaków) i `pinterest.description` (do 800), pisane pod wyszukiwarkę („plan posiłków na tydzień”, „lista
  zakupów”). Bez nich tytułem jest pierwsze zdanie opisu, a opisem opis posta bez pytania do komentujących,
  „linku w bio” i hashtagów. Przy `ai_imagery` pin dostaje oznaczenie treści AI.

## Statystyki (co działa, a co nie)

Workflow „Statystyki” raz dziennie (4:23 w nocy) pobiera wyniki z Instagrama, Facebooka i TikToka (przez Zernio)
i zapisuje `insights/latest.json` (każdy post: wyświetlenia, zasięg, polubienia, komentarze, zapisy, udostępnienia,
średni czas oglądania; do tego język, pora i pierwsza linia opisu) oraz jeden wiersz dziennie w `insights/history.jsonl`.
Pole `summary` ma mediany dla rolek/karuzel/kart, PL/EN i pór dnia oraz 5 najlepszych i 5 najsłabszych postów.
Automat treści czyta ten plik przed dopisaniem kolejnych postów.

Pełne dane z Instagrama wymagają w tokenie uprawnienia `instagram_manage_insights`, a zasięg postów na Facebooku
`read_insights`. Bez nich są tylko polubienia, komentarze i liczba obserwujących; pole `missing` mówi, czego brakuje.
Repo jest publiczne, więc te liczby też są publiczne.

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

## TikTok przez Zernio (zalecane, publicznie)

Rolki (`"type": "reel"` z `"tiktok"` w `platforms`) idą na TikToka przez **Zernio**
(dawniej Late, https://zernio.com). To zatwierdzony partner TikToka, więc filmy są **publiczne**.
Koszt: 1–2 podłączone konta za darmo, pełne API w cenie. Gdy jest sekret `ZERNIO_API_KEY`,
automat używa Zernio i nie dotyka bezpośredniego API TikToka (sekcja niżej).

Co wysyła automat (`scripts/zernio.mjs`): `POST /v1/posts` z `publishNow: true`, filmem
pod publicznym adresem z tego repo, prywatnością `PUBLIC_TO_EVERYONE` (zmienna `TIKTOK_PRIVACY`
może to zmienić), oznaczeniem promocji własnej marki (`brand_organic`), oznaczeniem AI
(`video_made_with_ai`) przy postach z `"ai_imagery": true` i okładką z `cover`.

### Konfiguracja (raz, ok. 5 minut)

1. Załóż konto na https://zernio.com.
2. W panelu Zernio podłącz konto TikTok WE.LIFE (Connect → TikTok, zaloguj się na TikToka i zatwierdź).
3. https://zernio.com/dashboard/api-keys → **Create API key**. Skopiuj klucz (`sk_…`), pokazuje się raz.
4. Sekrety repo (Settings → Secrets and variables → Actions → New repository secret):
   - `ZERNIO_API_KEY`: klucz z kroku 3,
   - `ZERNIO_TIKTOK_ACCOUNT_ID`: opcjonalnie; bez niego automat sam znajdzie jedyne konto TikTok w Zernio.
5. Actions → **Sprawdź konfigurację** → Run workflow. W logu ma być
   `TikTok (Zernio): … · konto … · prywatność: PUBLIC_TO_EVERYONE, …`.

Limity Zernio: 25 postów na godzinę na konto; duplikat tego samego tekstu w ciągu 24 h jest
odrzucany (automat traktuje go jako już opublikowany). Ponowienie po błędzie używa nowego
klucza idempotencji, więc nie tworzy dwóch postów.

## TikTok bezpośrednio przez API TikToka (zapasowo, tylko prywatnie)

Używane tylko wtedy, gdy nie ma `ZERNIO_API_KEY`.

### Opis bezpośredniej ścieżki

Automat publikuje na TikToku tylko **rolki** (`"platforms": [..., "tiktok"]`, `"type": "reel"`),
przez oficjalne Content Posting API (Direct Post, wysyłka pliku MP4 z repo). Bez sekretów TikToka
platforma jest pomijana bez błędu.

### Najpierw uczciwie: widoczność publiczna

- **Aplikacja bez audytu TikToka publikuje tylko prywatnie.** Dokumentacja: „All content posted by
  unaudited clients will be restricted to private viewing mode”. Dlatego domyślnie `TIKTOK_PRIVACY=SELF_ONLY`.
- **Audyt raczej nie przejdzie dla narzędzia wewnętrznego.** Wytyczne TikToka (Content Sharing Guidelines)
  wymieniają jako niedozwolone: „A utility tool to help upload contents to the account(s) you or your team
  manages” i oczekują aplikacji dla szerokiego grona użytkowników, z interfejsem wyboru prywatności itd.
- W praktyce: filmy trafią na konto TikTok jako **prywatne**. Żeby były widoczne dla wszystkich, trzeba
  w aplikacji TikTok zmienić prywatność filmu ręcznie (⋯ → Ustawienia prywatności → Wszyscy) albo
  publikować na TikToku ręcznie. Nie potwierdziliśmy, czy TikTok pozwala zmienić prywatność filmu
  opublikowanego przez aplikację bez audytu.

### Konfiguracja (raz)

1. Konto TikTok WE.LIFE (najlepiej konto firmowe/twórcy), zalogowane w przeglądarce.
2. https://developers.tiktok.com → **Manage apps → Connect an app** → dane WE.LIFE.
3. W aplikacji dodaj produkty **Login Kit** i **Content Posting API** (włącz **Direct Post**),
   zakresy `user.info.basic` i `video.publish`.
4. Login Kit → **Redirect URI**: `https://welife.world/` (dokładnie tak; TikTok dopisze `?code=...`).
5. Wyślij aplikację do przeglądu albo użyj trybu **Sandbox** z kontem WE.LIFE jako użytkownikiem testowym
   (zakres `video.publish` musi być zatwierdzony dla aplikacji, inaczej autoryzacja go nie przyzna).
6. U siebie, w katalogu repo (Node 22+):
   ```bash
   TIKTOK_CLIENT_KEY=... TIKTOK_CLIENT_SECRET=... node scripts/tiktok-auth.mjs
   ```
   Otwórz wypisany adres, zatwierdź dostęp, wklej adres z paska po przekierowaniu. Skrypt wypisze
   `TIKTOK_REFRESH_TOKEN` i `TIKTOK_VAULT_KEY`.
7. Sekrety repo: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REFRESH_TOKEN`, `TIKTOK_VAULT_KEY`.
   Zmienna repo (opcjonalna): `TIKTOK_PRIVACY` (domyślnie `SELF_ONLY`; po ewentualnym audycie `PUBLIC_TO_EVERYONE`).
8. Actions → **Sprawdź konfigurację** → log pokaże `TikTok: @konto · prywatność: ...`.
9. Do postów w `queue/` dopisz `"tiktok"` w `platforms` (tylko rolki). Opis bierze się z `caption`
   albo z `tiktok.caption`; maks. 5 hashtagów i 2200 znaków.

### Jak działają tokeny

TikTok **rotuje refresh token przy każdym odświeżeniu** (stary przestaje działać). Automat zapisuje nowy
token zaszyfrowany (AES-256-GCM, klucz `TIKTOK_VAULT_KEY`) w `vault/tiktok.json.enc` i commituje go razem
ze stanem. Odświeża tylko wtedy, gdy jest rolka do wysłania albo przy cotygodniowym sprawdzeniu, a access
token (ważny 2 h) używa ponownie. Gdy trzeba połączyć konto od nowa: uruchom ponownie `tiktok-auth.mjs`
i podmień sekret `TIKTOK_REFRESH_TOKEN` (automat sam rozpozna nowy sekret, pliku `vault/` nie trzeba kasować).
Bez `TIKTOK_VAULT_KEY` automat nie odświeży tokenu, żeby go nie zgubić. Film z ilustracjami AI
(`ai_imagery: true`) dostaje etykietę TikToka „AI-generated” (`is_aigc`), a post jest oznaczony jako promocja
własnej marki (`brand_organic_toggle`).

## Czego API nie zrobi (zostaje ręcznie)

- **Przypięcie posta** na profilu IG.
- **Muzyka z biblioteki Instagrama**: rolki z API wychodzą z dźwiękiem z pliku. Dlatego każda rolka
  ma w pliku własny podkład i efekty (`welife-app` → `marketing/instagram/tools/soundtrack.py`).
- **Przełącznik „Etykieta AI”**: zamiast niego tekst każdego posta z obrazami AI mówi o tym wprost
  (bezpiecznik `ai_imagery`). Po publikacji możesz dodatkowo włączyć etykietę w edycji posta, jeśli aplikacja ją pokazuje.
- Odpowiedzi na komentarze i wiadomości (PLAN) obsługujesz w Meta Business Suite.

## Uwagi

- GitHub uruchamia harmonogram z opóźnieniem do kilkunastu minut. Post z 18:30 wyjdzie ok. 18:30–18:50.
- Limit Meta: 50 postów przez API na dobę na konto IG. Ten plan to kilka tygodniowo.
- GitHub wyłącza harmonogram w repo bez aktywności przez 60 dni. Każdy nowy post w kolejce to aktywność.
- Repo jest publiczne: **nigdy nie wpisuj tokenu do plików**, tylko do sekretów.
