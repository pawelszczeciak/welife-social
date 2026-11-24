# „Wigilia w liczbach”: projekt karty do udostępnienia

Stan na 24.11.2026: **projekt do decyzji, nic nie jest wdrożone**. Planer działa bez zmian.
Przygotowane na prośbę Codexa w welife-app#841: bez imion domyślnie, z rzeczywistymi liczbami, bez nowej domeny.

## Co to jest

Przycisk w planerze Wigilii, który z bieżącego planu robi obrazek 1080×1920 do wysłania na rodzinną grupę albo do relacji.
Mechanizm jest ten sam co w grudniowych podsumowaniach roku: własne liczby, gotowy obrazek, jedno dotknięcie.

| Plik | Co pokazuje |
|---|---|
| `karta-bez-imion.jpg` | wariant domyślny: 6 kafli z liczbami i liczba pozycji na liście |
| `karta-z-imionami.jpg` | wariant po świadomym włączeniu imion: te same liczby i podział „kto ile robi” |

Liczby na makietach nie są wymyślone: skrypt otwiera planer i czyta je z jego własnych funkcji
(6 osób, domyślne potrawy; w wariancie z imionami przykładowy podział z kampanii „Kto robi barszcz?”).

## Skąd każda liczba

| Pole na karcie | Źródło w planerze |
|---|---|
| osób przy stole | wybrana liczba osób |
| potraw | zaznaczone potrawy (bez pozycji „Pieczywo i opłatek”) |
| pierogów, uszek | porcja z opisu potrawy (6 szt. na osobę) × liczba osób; kafel znika, gdy potrawa nie jest zaznaczona |
| barszczu | 250 ml na osobę × liczba osób |
| zadań w 3 dni | liczba pozycji w planie na 3 dni, razem ze sprawami poza kuchnią |
| pozycji na liście zakupów | liczba wierszy listy zakupów |
| kto ile robi | liczba zadań z planu przypisanych do każdego imienia |

Jeśli zaznaczonych potraw z policzalną porcją jest mniej, kafle uzupełniają inne liczby z planu (np. karp w dzwonkach, kompot w litrach).

## Zasady

- **Imiona są wyłączone domyślnie.** Podział „kto ile robi” pojawia się dopiero po zaznaczeniu „pokaż imiona na karcie”.
  Na karcie nie ma oceny ani komentarza do podziału, same liczby.
- **Nic nie opuszcza telefonu.** Obrazek powstaje w przeglądarce, tak jak cały planer. Bez konta, bez plików cookie, bez serwera.
- **Bez nowej domeny.** Na karcie nie ma adresu do przepisania. Link do planera idzie w tekście wiadomości razem z obrazkiem
  („Policz swoją: …”), a przy relacji planer kopiuje link do schowka, żeby dało się go wkleić w naklejkę.
- **Bez cen i bez obietnic o aplikacji.** Na dole jest tylko „Policzone w darmowym planerze Wigilii” i znak WE.LIFE.

## Jak miałoby działać

1. W sekcji „Wyślij rodzinie” dochodzi przycisk „Pokaż naszą Wigilię w liczbach” i pole wyboru „pokaż imiona na karcie” (odznaczone).
2. Po dotknięciu planer rysuje kartę i otwiera systemowe udostępnianie z obrazkiem i tekstem z linkiem do tego samego planu.
3. Gdy przeglądarka nie umie udostępnić pliku, karta pobiera się jako obraz, a link trafia do schowka.

## Kryteria odbioru (propozycja)

| Przypadek | Oczekiwany wynik |
|---|---|
| 6 osób, domyślne potrawy | 6, 9, 36, 36, 1,5 l, 18 oraz „23 pozycje” jak na makiecie |
| odznaczone pierogi | kafel „pierogów” znika, układ się nie rozsypuje |
| imiona wpisane, pole wyboru odznaczone | na karcie nie ma żadnego imienia |
| imiona wpisane, pole zaznaczone | podział sumuje się do liczby zadań przypisanych; zadania bez osoby nie są nikomu doliczone |
| telefon bez udostępniania plików | obraz się pobiera, link jest w schowku, pojawia się krótka informacja |
| link z wiadomości | otwiera ten sam plan, a dopisek źródła `?z=karta` przechodzi do linków rejestracji |

## Koszt i zależności

- Zmiana dotyczy tylko statycznej strony planera (`welife-social`, `site/wigilia/index.html`): ok. pół dnia pracy z testem na telefonie.
- Planer jest właśnie przenoszony do domeny (#837). Jeśli karta ma wejść, to przed odbiorem portu albo jako osobna, druga zmiana,
  żeby Grok nie przenosił pliku w trakcie przeróbki.
- Decyzja właściciela: czy wdrażać, i czy z wariantem imion.

## Źródła makiety

`welife-app`, gałąź `claude/inspiring-maxwell-n89ylj`, `marketing/instagram/kampania/wigilia-w-liczbach/`:
`karta.cjs` (czyta liczby z planera i składa `karta.html`), `liczby.json` (odczyt z 24.11.2026).
