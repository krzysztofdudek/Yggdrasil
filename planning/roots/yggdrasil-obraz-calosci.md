# Yggdrasil — obraz całości

Dokument dla właściciela projektu: kompletny, warstwowy opis tego, czym Yggdrasil jest dzisiaj
i czym się stanie po dodaniu warstwy „roots". Wszystko poniżej pochodzi z podręcznika `yg prime`,
tematów `yg knowledge`, schematów `yg schemas` oraz — dla rozdziału o roots — z finalnego designu
integracji i raportu z prototypu (oba z 2026-08-17). Rzeczy zaprojektowane, ale jeszcze
niezaimplementowane, są wyraźnie oznaczone.

---

## 1. Problem i teza produktu

Agenci AI piszą dziś większość kodu w wielu repozytoriach — ale każda sesja agenta zaczyna się
od zera. Reguła ustalona w poniedziałek („UI nie sięga bezpośrednio do bazy", „każdy handler
loguje audyt") w czwartek już nie istnieje: nowa sesja jej nie zna, człowiek nie wyłapie
naruszenia w review setek wygenerowanych linii, a klasyczne lintery ogarniają tylko to, co da
się wyrazić składniowo. Wiedza architektoniczna żyje w głowach i w zamkniętych rozmowach —
i eroduje z każdą zmianą.

Teza Yggdrasila, w pięciu punktach:

1. **Reguła zapisana raz obowiązuje w każdej przyszłej sesji.** Reguły są plikami w repo,
   wersjonowanymi jak kod, doczepionymi do architektury — nie do rozmowy.
2. **Agent dostaje tylko reguły dotyczące pliku, który edytuje.** Nie czyta całej konstytucji;
   `yg context --file` mówi mu, co obowiązuje *tutaj*.
3. **Zmiana musi spełnić reguły, zanim pójdzie dalej.** Recenzent (skrypt lokalny albo osobny
   model LLM) weryfikuje kod przeciw regułom; naruszenie blokuje.
4. **Każdy werdykt jest przypięty hashem do kodu, który sprawdził.** Werdykt jest ważny
   dokładnie dopóty, dopóki nie zmieni się żaden z jego wejść — potem para wraca do stanu
   „niezweryfikowane".
5. **CI odtwarza dowód bez klucza API.** Werdykty LLM są zapisane w commitowanym locku; CI tylko
   przelicza hashe i uruchamia darmowe checki deterministyczne — zero wywołań modelu, zero
   sekretów w pipeline.

Bez tego: dryf architektury, reguły-folklor, regresje tych samych błędów, brak śladu *dlaczego*
coś jest tak, a nie inaczej. Z tym: architektura jako egzekwowalny, audytowalny kontrakt.

---

## 2. Obraz całości w jednym akapicie

W katalogu `.yggdrasil/` żyje **graf**: słownik typów (`yg-architecture.yaml`), **węzły** (model
komponentów zmapowany na pliki źródłowe), **aspekty** (egzekwowalne reguły), **flows** (procesy
biznesowe) i **lock** (zapisane werdykty). CLI `yg` nigdy nie modyfikuje ani źródeł, ani plików
grafu — graf piszesz ręcznie, a lock piszą wyłącznie `yg check --approve` i `yg log
merge-resolve`. Agent w każdej sesji: czyta protokół (`yg prime`), sprawdza stan (`yg check`),
przed edycją pliku pobiera obowiązujące reguły (`yg context --file`), edytuje, dopisuje WHY do
logu węzła, a na końcu jednorazowo domyka weryfikację (`yg check --approve`). Każdy komunikat
błędu CLI ma strukturę WHAT/WHY/NEXT — mówi co się stało, dlaczego to problem i jaką komendę
uruchomić dalej.

---

## 3. Graf architektury i klasyfikacja plików

**Co to jest.** `yg-architecture.yaml` to słownik typów węzłów projektu: każdy typ ma opis,
opcjonalny predykat `when` klasyfikujący pliki (glob `path:` + regex `content:`, łączone przez
`all_of`/`any_of`/`not`), domyślne aspekty, dozwolonych rodziców w hierarchii i dozwolone typy
relacji do innych typów (z polityką `default: allow|deny`, listą celów, `[]` = zakaz,
`['*']` = wszystko).

**Po co.** To fundament: typ decyduje, jakie reguły plik dostaje „z urzędu" (kanał 3 propagacji),
gdzie węzeł może żyć w hierarchii i z czym wolno mu się wiązać. Dwa rodzaje typów: **klasyfikujące**
(mają `when` — pliki w mapowaniach muszą go spełniać) i **organizacyjne** (bez `when` — tylko
rodzice w hierarchii, bez własnych plików). Typ z `enforce: strict` działa też wstecz: każdy plik
w repo pasujący do `when` MUSI należeć do węzła tego typu (błędy `type-strict-orphan` /
`type-strict-misplaced`) — domyka to unik „nazwę plik inaczej i reguła mnie nie dotyczy".
Typ może też mieć `log_required: true` — wtedy każda zmiana źródeł jego węzłów wymaga wpisu WHY
(rozdz. 10).

**Pokrycie (coverage).** W `yg-config.yaml` blok `coverage:` mówi, które pliki muszą być
zmapowane: `required` (niezmapowany plik = błąd blokujący), `excluded` (plik całkowicie
niewidzialny dla całego systemu — to filtr absolutny, silniejszy nawet od jawnego mapowania)
oraz `type_level` — gdy włączone, plik pasujący do dokładnie jednego typu klasyfikującego liczy
się jako pokryty przez sam typ, bez własnego węzła; egzekwują go wtedy wyłącznie reguły
`per: file` tego typu.

**Jak tego dotykam.** `yg schemas read architecture`, `yg type-suggest --file <p>` (do którego
typu plik by pasował), `yg impact --type <id>`. Zmiany architektury zawsze wymagają potwierdzenia
użytkownika — agent nie edytuje tego pliku po cichu.

---

## 4. Węzły — model tego, co istnieje

**Co to jest.** Węzeł to komponent: katalog `model/<ścieżka>/yg-node.yaml` z nazwą, typem,
opisem, mapowaniem plików (dokładne ścieżki, katalogi, globy minimatch; dziecko może „wyjąć"
konkretny plik z globa rodzica), aspektami, relacjami i portami. Węzły zagnieżdżają się
katalogowo — dzieci dziedziczą aspekty rodzica.

**Po co.** Węzeł to punkt zaczepienia reguł, relacji, przepływów i logu WHY. Jeden węzeł na
spójny obszar funkcjonalny (nie na katalog, nie na plik). Przy włączonym `type_level` plik nie
potrzebuje węzła, żeby być egzekwowany — węzeł piszesz tam, gdzie masz coś do powiedzenia ponad
typ: relację, log, udział we flow.

**Jak tego dotykam.** `yg tree` (struktura grafu), `yg owner --file` (kto jest właścicielem
pliku), `yg context --node` (pełny przegląd węzła), `yg find "<zapytanie>"` (wyszukiwanie
naturalnym językiem — wyniki mają względne score'y, top zawsze 1.00).

---

## 5. Aspekty — egzekwowalne reguły

**Co to jest.** Aspekt to katalog `aspects/<id>/` z `yg-aspect.yaml` plus źródłem reguły.
Rodzaj recenzenta jest **wnioskowany z plików**:

| Plik reguły | Rodzaj | Kto ocenia | Koszt |
|---|---|---|---|
| `content.md` | LLM | model językowy czyta prozę reguły + pliki i wydaje werdykt | płatny per para (× consensus) |
| `check.mjs` | deterministyczny | lokalna funkcja `check(ctx)` z dostępem do plików, AST (tree-sitter), grafu | zero — darmowy, bez klucza |
| żaden, ale `implies:` | agregujący | nikt — to nazwany pakiet innych aspektów | zero |

Aspekt LLM może dodatkowo mieć `references:` (pliki wspierające dołączane do każdego promptu)
i `companion.mjs` (hak per jednostka, dobierający dynamicznie pliki towarzyszące do promptu —
nigdy nie ocenia, tylko wskazuje ścieżki). Aspekt deterministyczny może deklarować `errs:
over|under|exact` — uczciwy kierunek błędu checka (`under` = zero fałszywych alarmów z definicji).

**Statusy.** `draft` (reguła w budowie — zero par, zero kosztu), `advisory` (weryfikowana, ale
naruszenie to tylko ostrzeżenie), `enforced` (naruszenie i brak weryfikacji blokują build).
Status to wyłącznie sposób renderowania — nigdy nie unieważnia werdyktu; flip
advisory↔enforced↔draft nie kosztuje ani jednego wywołania recenzenta. Parkowanie reguły =
`draft`, nigdy edycja `when` (GC usuwa pary wykluczone przez `when`, a draftowe zachowuje).
Opcjonalne `review_by: YYYY-MM-DD` to data przeglądu — po jej minięciu `yg check` ostrzega
(nigdy nie blokuje); zmiana tej daty to decyzja człowieka.

**Zakres (`scope`).** `per: node` (domyślnie — jeden werdykt na cały węzeł; dla reguł
międzyplikowych) albo `per: file` (werdykt per plik; tylko dla reguł lokalnych dla pliku — i
jedyny zakres, który dosięga plików pokrytych samym typem). Opcjonalny filtr `scope.files`
zawęża pliki-przedmioty. Edycja scope unieważnia wszystkie pary aspektu.

**Warunki (`when:`).** Jeden wspólny język predykatów (`all_of`/`any_of`/`not`) w trzech
miejscach: `when:` aspektu filtruje WĘZŁY (atomy `node`, `relations`, `descendants` — np. „tylko
węzły, które wołają klienta usług"), `when` typu w architekturze i `scope.files` filtrują PLIKI
(atomy `path`, `content`). Ewaluacja jest deterministyczna i darmowa — zawsze lepsza niż
zostawianie decyzji o stosowalności w prozie reguły. Klasyczny wzorzec: szeroki zakaz
kaskadowany z rodzica z wyjątkiem `when: { not: { node: { type: data-access } } }` dla jednej
warstwy, której wolno.

**Siedem kanałów propagacji.** Aspekt dociera do węzła przez: (1) własną listę węzła,
(2) przodka w hierarchii, (3) własny typ, (4) typ przodka, (5) flow, (6) konsumowany port,
(7) `implies:` innego aspektu. Recenzent sprawdza WSZYSTKIE naraz; efektywny status to max() po
kanałach (podbicie w górę OK, próba obniżenia = błąd walidatora).

**Koszt.** Liczony per para (aspekt, jednostka). Edycja `content.md` szeroko używanego aspektu
re-weryfikuje każdy używający go węzeł — przed taką zmianą zawsze `yg impact --aspect <id>`;
podgląd całego rachunku przed fill: `yg check --approve --dry-run` (górne ograniczenie liczby
wywołań recenzenta, wypisane za darmo).

**Jak tego dotykam.** `yg aspects` (lista), `yg aspects --health` (rozdz. 12),
`yg schemas read aspect`, `yg knowledge read writing-llm-aspects` /
`writing-deterministic-aspects`.

---

## 6. Relacje i porty

**Co to jest.** Relacje to typowane zależności między węzłami — sześć typów: strukturalne
`calls`, `uses`, `extends`, `implements` oraz zdarzeniowe `emits`, `listens`. Strukturalne muszą
tworzyć DAG (cykl = zawsze blokujący `structural-cycle`); zdarzeniowe są poza tą regułą — to
sankcjonowany sposób modelowania dwukierunkowości, ale muszą być sparowane (każde `emits` A→B
wymaga jakiegoś `listens` B→A).

**Wbudowany check zgodności relacji.** Przy KAŻDYM `yg check` (bez cache, na żywo, zero kosztu
LLM) CLI parsuje wszystkie zmapowane źródła (12+ języków), znajduje statycznie rozwiązywalne
zależności między węzłami i ODRZUCA węzeł zależny od węzła, do którego nie deklaruje relacji
(`relation-undeclared-dependency`). To nie aspekt: nie ma statusu, nie da się go wyciszyć
suppressem; jedyne wyjścia to zadeklarować relację albo usunąć zależność. Dwie własności dają
zero fałszywych alarmów: jednokierunkowość (wykryta zależność wymaga deklaracji, ale deklaracja
nie wymaga kodu — DI, refleksja, HTTP są legalne) i „tylko zmapowane, tylko jednoznaczne" cele.

**Porty.** Gołe relacje NIE przenoszą aspektów przez granicę. Port to nazwane wejście węzła z
wymaganymi aspektami; konsument deklaruje `consumes: [port]` na relacji i aspekty portu stają
się dla niego obowiązujące (kanał 6). To obrona przed unikiem „wyniosę wrażliwy kod do helpera
poza zasięgiem reguły": cel z portami wymusza `consumes` (brak = blokujący
`port-missing-consumes`), więc luka jest zawsze widoczna.

**Jak tego dotykam.** Relacje w `yg-node.yaml` (płaska lista z `type:` i opcjonalnym
`consumes:`), `yg knowledge read ports-and-relations`, `yg structure` (read-only dashboard:
„tunele" zależności przez hierarchię, grupy modułów per poziom i cykle między nimi, zasięg
zmiany — instrument, nigdy bramka).

---

## 7. Flows — procesy biznesowe

**Co to jest.** Flow (`flows/<nazwa>/yg-flow.yaml`) to proces biznesowy — „użytkownik składa
zamówienie", nie sekwencja wywołań. Ma opis, uczestników (węzły; potomkowie uczestnika wchodzą
automatycznie) i aspekty, które propagują do wszystkich uczestników (kanał 5).

**Po co.** Wspólne reguły przekrojowe procesu (idempotencja, correlation ID, audyt) w jednym
miejscu; dodanie dziecka pod uczestnikiem nie wymaga edycji flow.

**Jak tego dotykam.** `yg flows`, `yg impact --flow <nazwa>` (koszt zmiany aspektów flow).

---

## 8. Lock i weryfikacja — serce systemu

**Co to jest.** Weryfikacja biegnie per para *(aspekt, jednostka)*; jednostka to cały węzeł albo
jeden plik (wg `scope`). Werdykt (approved/refused) ląduje w locku jako wpis adresowany
zawartością. Lock to triada plików: `yg-lock.nondeterministic.json` (commitowany — werdykty
LLM), `yg-lock.logs.json` (commitowany — baseline logów/domknięć per węzeł),
`.yg-lock.deterministic.json` (gitignorowany cache — werdykty deterministyczne, odbudowywalny za
darmo). Plik nieistniejący = pusty stan; plik uszkodzony = blokujący `lock-invalid` (fail
closed).

**Co unieważnia werdykt.** Hash pary składa: id aspektu, kanoniczny scope, ścieżkę węzła, hash
źródła reguły (`content.md`/`check.mjs`), posortowaną listę [plik, sha256] przedmiotów i token
werdyktu; pary LLM dokładają opis aspektu, referencje i NAZWĘ tieru; pary z companionem — hash
`companion.mjs` i wszystkie obserwacje haka; pary deterministyczne — pełny zbiór obserwacji
checka (każdy odczyt pliku, listing, probe `exists`, zapytanie o graf — także negatywne).
Zmiana czegokolwiek z tego = para „unverified". Celowo POZA hashem: status, treść uzasadnienia,
opis węzła, konfiguracja tieru (tylko nazwa się liczy — można podmienić model pod tierem bez
re-weryfikacji), `max_prompt_chars`, `when`/`implies`/porty (działają przez zbiór oczekiwanych
par, nie przez unieważnianie) i wersja CLI. Ręczna edycja locku degeneruje wpis do „unverified",
nigdy do zielonego — to dowód manipulacji na poziomie „przejrzyj diff w PR", nie kryptografia.

**Odmowa jest ostateczna.** Zapisany refusal dla niezmienionych wejść NIE jest re-rollowany —
trzy wyjścia: napraw kod, zaostrz regułę (re-weryfikuje wszystkich użytkowników — najpierw
`yg impact`), albo `yg-suppress` za zgodą użytkownika. Celowo nie ma komendy „osądź jeszcze
raz"; kosmetyczna edycja wymuszająca re-roll to pranie werdyktów. Awarie infrastruktury
(provider padł, brak recenzenta, check się wywalił) nie zapisują NIC — para zostaje
niezweryfikowana, build czerwony, nigdy zielony nad kodem, którego nikt nie widział.

**Merge i sprzątanie.** Konflikt w commitowanym locku: weź JEDNĄ stronę w całości, potem
`yg check --approve` — błędnie zachowany wpis nie może skłamać (hash się nie zgodzi, para się
re-weryfikuje). Po udanym `--approve` garbage collection wycina wpisy par, które przestały
istnieć (aspekt odpięty, plik usunięty) — ale zachowuje pary draftowe i wszystko, czego nie da
się pozytywnie dowieść jako odpięte.

---

## 9. `yg check` — jedna bramka, wiele widoków

**Co to jest.** `yg check` domyślnie NIE pisze nic i nie woła LLM: przelicza hashe wpisów locku,
uruchamia na żywo check relacji, waliduje pokrycie i strukturę. `yg check --approve` wypełnia
KAŻDĄ niezweryfikowaną parę (najpierw deterministyczne za darmo; węzeł z deterministyczną
odmową ma pomijane pary LLM — zepsuty węzeł nigdy nie bilinguje recenzenta), potem raportuje.
`yg check --approve --only-deterministic` wypełnia tylko pary darmowe i pisze tylko gitignorowany
cache — to bramka CI/pre-commit: tania, bez klucza, zero churnu w commitowanych plikach.
`--approve --dry-run` = darmowy kosztorys. Opcjonalne `auto_approve` w configu
(false/"deterministic"/"full") zmienia zachowanie gołego `yg check`; jawne flagi zawsze
wygrywają.

**Widoki.** Domyślne wyjście jest grupowane (jeden blok per reguła). Widoki read-only:
`--summary` (liczniki per węzeł), `--top [N]` (N najważniejszych grup), `--aspect <id>`
(drill w jedną regułę), `--details` (stary widok per para). Każdy widok zawsze drukuje
prawdziwy nagłówek `Errors (N)`/`Warnings (N)` i zachowuje kod wyjścia — zawężenie nie może
udawać czystego buildu. `suggestedNext` na końcu wskazuje jeden konkretny następny krok.

**Rytm pracy.** Iteruj edycje z darmowym `yg check`; `--approve` uruchom dokładnie RAZ na
końcu — każda edycja po `--approve` unieważnia świeżo opłacone werdykty.

---

## 10. Log WHY — pamięć intencji

**Co to jest.** Per-węzłowy `log.md` (append-only, pisany tylko przez `yg log add`) niesie
DLACZEGO — decyzje biznesowe, ograniczenia zewnętrzne, pułapki. CO zmieniono jest w diffie;
log to motywacja, która nie gnije razem z kodem. Recenzent logu NIE widzi — to kontekst dla
przyszłych agentów, nie wejście egzekwowania.

**Bramka.** Typy z `log_required: true` wymagają świeżego wpisu, gdy źródła węzła zmieniły się
od ostatniego „pozytywnego domknięcia" (moment, gdy wszystkie enforced pary węzła były zielone).
Brak wpisu to blokujący błąd już w zwykłym `yg check`; przy `--approve` bramka jest
wszystko-albo-nic (jeden brakujący wpis = nic się nie wypełnia). Jeden wpis obowiązuje przez
cały cykl aż do domknięcia — retry po odmowie nie wymaga nowego. Wpisy muszą być samowystarczalne
(żadnych odwołań do planów, ścieżek, numerów kroków); korekta = konwencja „Supersedes", nigdy
edycja historii. Po merge'u gita z konfliktem logów: `yg log merge-resolve --node <p>`.

**Jak tego dotykam.** `yg log add/read` (`--with-verdicts` przeplata wpisy z historią
werdyktów z lokalnej telemetrii), `yg knowledge read log-management`.

---

## 11. Suppressions — udokumentowane wyjątki

**Co to jest.** Komentarz `yg-suppress(<aspekt-id>) <powód>` w kodzie każe recenzentowi pominąć
dany aspekt: forma jednoliniowa (waiwuje TYLKO linię poniżej), klamrowa
`yg-suppress-disable/enable` (zakres), goły `disable` na szczycie pliku (cały plik), wildcard
`*` (wszystkie aspekty w zakresie). Zakres rozwiązywany raz, do zakresów linii; oba rodzaje
recenzentów honorują identyczne zakresy. Marker w bloku kodu Markdowna to przykład, nie waiver.

**Zasady.** Suppress NIGDY nie powstaje bez jawnej zgody użytkownika — powód podaje lub
zatwierdza człowiek. Nie działa na checki wbudowane (relacje, walidatory). `yg suppressions` to
read-only inwentarz aktywnych markerów z ostrzeżeniami (nieznane id, wildcard, niedomknięty
zakres, waiver na check `errs: under`, który z definicji nie ma czego waiwować).

---

## 12. Warstwa uwagi: advise, incident, health

**`yg advise`** — read-only warstwa uwagi; nigdy nie bramkuje, nie pisze werdyktów, nie pojawia
się w `suggestedNext`. Dwie sekcje: **Attention** (agregaty: licznik incydentów — zawsze
widoczny, nawet 0; tunele zależności; odchylenia strukturalne plików) i **Nominations** (do 10
rankowanych, popartych dowodami propozycji: regresja której reguła już nie łapie, ryzykowny
waiver, reguła martwa/osierocona/przeterminowana, promocja czystej advisory, gorący punkt bez
pokrycia — kod najbardziej w ruchu z najmniejszą ochroną, kandydat na rodzinę reguł z klastrowania
strukturalnego, cięcie architektury przy cyklu grup). Każda pozycja ma WHAT/WHY/NEXT z akcją
człowieka. `dismiss`/`defer` (z obowiązkowym powodem) to ta sama klasa autoryzacji co suppress;
decyzje trafiają do commitowanego rejestru `advise-decisions.jsonl` (merge=union) — case law,
które wraca do feedu, gdy dowody się zmienią.

**`yg incident`** — commitowany rejestr tego, co PRZECIEKŁO przez egzekwowanie; jedyny sygnał
spoza grafu. Wpis (tag przyczyny: `no-rule`, `wrong-rule`, `judges-blind`, `single-judge-miss`,
`not-enforcement` + powód, opcjonalnie `--aspect`) to ludzkie świadectwo — agent może
zaproponować treść z relacji użytkownika, nigdy nie fabrykuje.

**`yg aspects --health`** — tablica zdrowia reguł: rozmiar powierzchni (węzły/pary), aktywne
odmowy, żywe suppressy, wiek reguły, **catch/exposure** (ile razy realnie złapała vs ile razy
była realnie ćwiczona — cache się nie liczy), sygnał fałszywych blokad (odmowy później uchylone
waiverem), join incydentów `wrong-rule`, etykieta `active`/`quiet`/`decorative?`. Wszystko z
uczciwymi etykietami przy małej próbie („unverified" zamiast „0"); nic tu nie bramkuje — to
karmi ludzki rytuał przeglądu reguł.

---

## 13. Narzędzia diagnostyczne i poznawcze

| Komenda | Co daje |
|---|---|
| `yg context --file/--node` | reguły obowiązujące tu (ścieżki `read:` do przeczytania PRZED edycją), właściciel, zależności, flows, stan logu; plus jednoliniowa adnotacja „plik strukturalnie nietypowy" (czysta uwaga, wyłączalna) |
| `yg impact --node/--file/--aspect/--flow/--type` | promień rażenia edycji: które pary się unieważnią, ile wywołań recenzenta, co jest darmowe |
| `yg aspect-test` | diagnostyka na żywo BEZ dotykania locku: uruchom check/recenzenta (`--dry-run` = podgląd promptu za darmo; `--repeat N` mierzy samo-spójność sędziego LLM; `--tier` = przymiarka przed zmianą modelu; `--check-determinism` dla checków) |
| `yg drill --aspect` | regresyjny korpus przypadków reguły (`violates-*` musi odmówić, `satisfies-*` przejść) — ostrzenie reguły; deterministyczne darmo, LLM billinguje |
| `yg simulate <check> --node` | replay kandydackiej reguły deterministycznej po historii commitów w izolowanym klonie: „co by złapała?" — raport, zawsze exit 0 |
| `yg structure` | dashboard strukturalny (tunele, moduły, zasięg zmiany) — instrument, nie bramka |
| `yg portal [--static]` | lokalny, loopback-only widok WWW grafu i stanu weryfikacji (jedna akcja Approve, wyłączalna `--no-write`; `--static` = samodzielny HTML) |
| `yg find` / `yg tree` / `yg aspects` / `yg flows` / `yg owner` / `yg type-suggest` | nawigacja i wyszukiwanie po grafie |

---

## 14. Wiedza wbudowana: prime, knowledge, schemas

`yg prime` drukuje pełny podręcznik operacyjny agenta prosto z zainstalowanego CLI (nie ma
pliku w repo, który mógłby się zestarzeć); `--digest` drukuje kanoniczny krótki blok
commitowany do AGENTS.md. `yg knowledge list/read` to ~16 głębokich tematów referencyjnych
(lock, aspekty, relacje, logi, meta-modeling, onboarding…). `yg schemas list/read` to
referencje pól pięciu elementów grafu (node, aspect, architecture, config, flow) — działają
nawet bez `.yggdrasil/`. Zasada podziału: rules/prime to mapa (workflow, słownik), CLI to GPS
(konkretne błędy z następną komendą) — wspólne słownictwo, zero duplikacji.

---

## 15. Instalacja i konfiguracja

**`yg init`** — bootstrap: interaktywny wizard w terminalu albo w pełni flagowo
(`--provider/--model/--endpoint`, `--no-reviewer` = bezkluczowy start bez sędziego LLM — checki
skryptowe, kontrola zależności i bramka CI działają od razu za darmo). Instaluje reguły
agentowe uniwersalnie i identycznie dla każdego agenta: blok digestu w `AGENTS.md`, import
`@AGENTS.md` w `CLAUDE.md` (Claude Code nie czyta AGENTS.md natywnie), `.clinerules/yggdrasil.md`
(Cline). `yg check` pilnuje świeżości digestu (`rules-digest-stale` → fix: `yg init --upgrade`).
`yg init --upgrade` odświeża artefakty reguł, `.gitattributes` (lock oznaczony
`linguist-generated`), `.yggdrasil/.gitignore` i podnosi wersję schematu configu. Uruchamiać
wyłącznie z korzenia repo. Klucze API tylko przez zmienne środowiskowe lub gitignorowany
`yg-secrets.yaml` — nigdy flagą.

**`yg-config.yaml`** — konfiguracja recenzenta i progu jakości: **tiery** recenzentów (nazwane
konfiguracje LLM: provider — hostowane API `anthropic`/`openai`/`google`/`ollama`/
`openai-compatible` albo bezkluczowe CLI `claude-code`/`codex`/`gemini-cli`; `consensus` —
nieparzysta liczba niezależnych głosów per para; `max_prompt_chars` — bramka rozmiaru promptu,
domyślnie 50000; aspekt wybiera tier przez `reviewer.tier:`, reszta bierze `reviewer.default`),
`parallel` (równoległość wypełnień LLM; deterministyczne mają własny auto-pool),
`auto_approve`, `coverage`, `quality.max_direct_relations` (z per-węzłowym, uzasadnianym
nadpisaniem), `signals.attention`, `events.committed_llm` (opcjonalny wspólny, commitowany
strumień zdarzeń fill LLM z wyciętym uzasadnieniem). Kluczowa własność: do hasha werdyktu
wchodzi tylko NAZWA tieru, więc lokalna podmiana modelu/klucza pod tą samą nazwą niczego nie
re-weryfikuje.

---

## 16. Meta-modeling — graf pilnujący samego siebie

Mapowanie plików spod `.yggdrasil/` do grafu jest dozwolone i opt-in (coverage nie nagabuje o
resztę katalogu). Motywacja: pętla zwrotna — dokument wymagań wskazuje w front-matter swój
check, a aspekt LLM z companionem czyta ten check i osądza, czy naprawdę realizuje wymaganie.
Reguły recenzują reguły. Cztery drogi pliku grafu przed recenzenta: mapowanie (staje się
przedmiotem), `references:`, `companion.mjs`, odczyt `ctx.fs` z checka. Zasady bezpieczeństwa:
mapuj wąsko (NIGDY całego `.yggdrasil/**` — lock by nigdy nie konwergował), doczepiaj przy
liściu, filtruj `scope.files`, trzymaj warstwę meta małą — samo-referencja rozszerza promień
unieważnień.

---

## 17. Onboarding — agent jako tutor

`yg knowledge read onboarding` to kompletny playbook uczenia człowieka przez rozmowę: agent
staje się tutorem na żądanie („wytłumacz mi", nowy członek zespołu), kalibruje ścieżkę
(builder/ewaluator/nawigator), uczy na ŻYWYM repo demonstracjami zero-trace (podstawiona
edycja → werdykt → revert, nigdy commitowana, nigdy nie wypełnia werdyktów nad zepsutym
stanem), cytuje stemple werdyktów dosłownie i kończy każdą lekcję samodzielnym powtórzeniem
użytkownika. Dziewięć lekcji od „poznaj mapę" po ścieżki dalsze per profil.

---

## 18. Roots — nadchodząca warstwa: architektura MIERZONA (zaprojektowane, nie zaimplementowane)

Wszystko powyżej działa dziś. Ten rozdział opisuje warstwę **zaprojektowaną** (finalny design
integracji, 2026-08-17) i **sprawdzoną prototypem** (`roots2.mjs`, zmierzone wyniki niżej) —
jeszcze nie ma jej w CLI.

**Idea.** Yggdrasil egzekwuje architekturę **deklarowaną** — graf, który autor napisał. Roots
dodaje architekturę **mierzoną**: konwencje, które repozytorium faktycznie utrzymuje, wydobyte
z AST wszystkich plików na wszystkich poziomach ziarnistości, przez CAŁĄ historię gita.
Graf mówi „postanowione", roots mówi „praktykowane" — i tylko jawny akt **promocji** przenosi
fakt z drugiego głosu do pierwszego. Zero wywołań LLM w całej warstwie (bez kluczy, kod nie
opuszcza maszyny); zero kodu per język — bindingi wyprowadzane z `node-types.json` gramatyk,
które CLI już wozi (13 gramatyk kodu + 3 danych).

**Dwa reżimy — prawo produktu.** (1) **Mowa niepytana** (ścieżka hook/check po edycji pliku):
bramkowana, budżetowana, deduplikowana, z automatyczną demotacją „zdrowia" reguł ignorowanych —
precyzja ponad kompletność, bo agent przestaje słuchać hałaśliwego narzędzia. (2) **Zapytanie**
(`where`, `spectrum`): odwraca kompromis — pełne pole konwencji z ciągłymi score'ami, próg w
rękach pytającego. Żadna powierzchnia nie może zamazać tej granicy.

**Lokalność.** Repo to wiele podsystemów: fakty żyją w kratownicy pakiet → katalog → rola
(grupa podobnych plików, klastrowana bez konfiguracji), z zarządzaniem specyficznością —
najbardziej specyficzny stosowalny kontekst rządzi, a komunikat zawsze niesie swój prawdziwy
zasięg („to lokalny domyślny tego katalogu — norma pakietu jest tu inna").

**Nigdy nie bramkuje CI** — decyzja właściciela, przewleczona przez cały design: semantyka
`yg check` nietknięta (co najwyżej jedna linijka informacyjna), jedyna powierzchnia zdolna do
bramkowania to jawnie opt-in `status --exit-code`; nawet promocja domyślnie tworzy aspekt
`advisory`, więc nie może zaczerwienić zielonego repo, zanim maintainer sam nie podniesie do
`enforced`. DENY (blokada zapisu) istnieje tylko w kanale pre-hooka sesji agenta, tylko dla
faktów po kalibracji (Wilson ≥0.9 przy ≥35 zdarzeniach) — zaprojektowana, oczekiwana rzadko.

**Komendy (`yg roots …`), wg designu:**

| Komenda | Rola |
|---|---|
| `index [--full]` | zbuduj/odśwież pole: ekstrakcja → słowniki → role → historia → akceptacja MDL → model; przyrostowo domyślnie (cache blobów), deterministycznie (bajt-w-bajt) |
| `check <pliki…>` | ścieżka werdyktu po edycji: tylko fakty rządzące, delta-gated, budżetowane; DENY tylko w JSON pre-hooka, nigdy w kodzie wyjścia |
| `where <zapytanie>` | odwrotne zapytanie na zimny start: intencja → miejsce + normy + egzemplarz do skopiowania + partnerzy co-change; `--path` = brief przed napisaniem pliku |
| `spectrum <plik>` | pełna kratownica konwencji jednego pliku, bez cięcia akceptacją — głęboka eksploracja na życzenie |
| `report` | całe pole: konwencje z dowodami, pokrycie/dług, trendy, kohorty, zdrowie, udział agentów, backlog kampanii normalizacyjnej |
| `status [--exit-code] [--diagnose]` | świeżość, tryby zdegradowane, dostępność DENY; `--diagnose` = doktor (gramatyki, determinizm, integralność); jedyna opt-in bramka |
| `explain <plik\|fakt>` | dlaczego fakt wystrzelił / nie wystrzelił: bramki, przesłanianie, demotacja — okno debugowania |
| `promote <fakt>` | most: konwencja → zwykły aspekt Yggdrasila — wygenerowany `yg-aspect.yaml` (proza + zdanie dowodowe) + samowystarczalny `check.mjs` z wrośniętą listą grandfathered (stare odchylenia przechodzą, nowe łamią); wpis w commitowanym rejestrze decyzji; po promocji maszyna odkrywająca nie ma żadnej roli w egzekwowaniu |
| `calibrate` | kalibracja temporalna per fakt; raportuje gotowość DENY |
| `seed add/list/rm`, `mute <fakt>` | sterowanie maintainera; mute = dismiss/defer roots, w rejestrze decyzji — bez markerów w źródłach |
| `hooks install` | opt-in okablowanie hooków agenta (claude-code/generic) i triggera post-commit; drukuje przed zapisem |
| `reset` | wyczyść stan pochodny (nigdy commitowane store'y) |

Integracje: `yg context --file` dostaje sekcję „konwencje tutaj"; `yg advise` jedną nową klasę
nominacji (`convention-candidate` — akcją człowieka jest `yg roots promote`); `yg prime` sekcję
protokołu (uniwersalna ścieżka bez hooków: `where` na starcie, `check` po edycji, sweep przed
końcem). Roots świadomie NIE pisze typów architektury, nie tworzy węzłów, nie dotyka
`yg-architecture.yaml` — norma ≠ intencja; jedyne przejście to `promote` i produkuje aspekt,
nigdy strukturę. Magazyn: `.yggdrasil/roots/` — commitowany `model.json` (deterministyczny
snapshot) + rejestry `decisions/ledger/seeds`, gitignorowane `.cache/`/`.state/`. Konfiguracja:
jeden blok `roots:` w istniejącym `yg-config.yaml`; brak bloku = warstwa uśpiona.

**Zmierzone wyniki prototypu.** Harness mutacyjny na 7 modelach (nest, immich, typeorm,
fastify, flask, starlette, samo repo Yggdrasila; TS/JS/Py, w tym pełne historie):
**65/65 wykrytych podłożonych odchyleń, 0 przeoczeń, 0 fałszywych alarmów, 130/130 ciszy na
plikach zgodnych**; model bajt-identyczny między stanami cache, pełna historia ~12 ms/blob
(flask: 3 824 commity w ~2 min na zimno, **0 s na ciepło**), a pętla promocji zweryfikowana na
żywo — odkryta granica dostępu do locku tego repo stała się działającym, bezkluczowym checkiem
CI (exit 0 na czystym drzewie, exit 1 na podłożonym naruszeniu).

---

## 19. Mapa mentalna — jedna sesja agenta

1. **`yg prime`** — agent wczytuje protokół (świeży, z zainstalowanego CLI).
2. **`yg check`** — stan zastany; błędy naprawia przed jakąkolwiek inną pracą.
3. Żądanie użytkownika → **`yg find`** (tłumaczy język biznesowy na punkt wejścia) →
   **`yg context --node/--file`** → czyta pliki z `read:` (reguły, które recenzent przyłoży) i
   **`yg log read`** (WHY poprzedników). *(Po wejściu roots: także `yg roots where` na zimny
   start i konwencje w `yg context`.)*
4. Nowy plik/moduł? Pre-flight w `yg-architecture.yaml`: typ, dozwoleni rodzice, relacje,
   mapowanie. Duża zmiana? **`yg impact`** i ewentualnie `--dry-run` — koszt przed faktem.
5. Edycje; iteracja z darmowym `yg check` (check relacji łapie niezadeklarowane zależności na
   żywo). Reguła nowa/ostrzona: status `draft` + **`yg aspect-test`**/**`yg drill`**, potem
   `advisory` → `enforced`. *(Po wejściu roots: `yg roots check <plik>` szepcze lokalną normę.)*
6. **`yg log add`** — wpis WHY per węzeł objęty bramką.
7. **`yg check --approve`** dokładnie raz: deterministyczne za darmo, LLM per para, werdykty do
   locku, pozytywne domknięcie węzłów.
8. **`yg check`** zielony = zmiana skończona. CI odtworzy dowód bez klucza:
   `yg check --approve --only-deterministic` + przeliczenie hashy commitowanych werdyktów LLM.

Obok pętli, w rytmie tygodniowym, człowiek przegląda **`yg advise`** (nominacje), **`yg aspects
--health`** (które reguły łapią, które są dekoracją), **`yg suppressions`** (audyt waiverów) i
**`yg incident`** (co przeciekło) — bo bramka egzekwuje reguły, ale to warstwa uwagi utrzymuje
je mądrymi.
