# Wstrzymane posty

Automat nie czyta tego katalogu. Posty o 7 sklepach partnerskich (Bee.pl, MarketBio, Coś dla zdrowia,
Vivi Polska, Cafes Guilis, Królewskie Miody, Bosalo) czekają, aż sekcja sklepów będzie włączona
na produkcji (`WELIFE_WEBEPARTNERS_AFFILIATE_ENABLED=true`, Bee osobno). Wtedy: ustaw `publish_at`
i `id` z datą, przenieś plik do `queue/` i dodaj pliki media (R17, K5 z welife-app).
Każdy post ujawnia linki partnerskie i możliwą prowizję.

## Wersje angielskie (`en/`), wstrzymane 11.11.2026

Decyzja właściciela: jedno konto = jeden język. Na obecnych kontach (@welife.world na Instagramie i TikToku,
strona WE.LIFE na Facebooku, kanał YouTube) wychodzą tylko treści polskie, 3 dziennie (8:30, 12:30, 18:30).
Po 9 dniach wersje angielskie miały takie same wyniki jak polskie (bliskie zera), a dwa języki na jednym
koncie utrudniają platformie dobranie widowni.

W `en/` leżą angielskie pozycje, które czekały w kolejce (pliki media zostały w `media/`). Wrócą na osobnych
kontach anglojęzycznych, gdy polskie zaczną działać. Wtedy: nowe `publish_at`, przeniesienie do `queue/`.
