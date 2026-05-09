# II/603 Sulice – Želivec, rekonstrukce silnice a mostů

Mobilní webová mapa stavby s navázanými výkresy PDPS, GPS sledováním polohy podle staničení a sdílenými poznámkami mezi uživateli.

## Použití

Aplikace běží na GitHub Pages: **https://pripravar.github.io/Sulice---Zelivec/**

Otevři v telefonu (Chrome / Safari), povol GPS a kompas.

## Funkce

- 🗺️ Podkladové mapy: Mapy.cz (Outdoor / Basic / Letecká) + OSM + katastrální vrstva ČÚZK (WMS)
- 📍 GPS sledování + zobrazení aktuálního staničení (km)
- 📏 Markery staničení (každých 100 m a 20 m) — kliknutím se otevře **PDF panel se všemi výkresy** pro daný km (situace, podélný profil, vzorové řezy, dopravní značení, technická zpráva)
- 🔵 Markery propustků (P1 km 2,405 / P2 km 3,071) — kliknutím PDF výkres + technická zpráva + sdílené poznámky
- 🏗️ Vrstva stavebních objektů SO 101 / 101.1 / 101.2 / 101.3 / 101.4 / 102 / 103 / 104 / 105 / 106 / 107
- 📝 Poznámky s GPS pinem (long-press na mapě), 7 kategorií, fotky s automatickým razítkem (km, datum, jméno)
- 🖼️ Standalone foto + sdílená galerie

## Struktura repa

```
index.html              ← celá aplikace (single-file HTML+JS)
pdf/
  SO_101/               ← výkresy SO 101 (intravilán)
  SO_102/               ← extravilán
  SO_103/               ← okružní křižovatka
  SO_104/               ← propustek 1 (km 2,405)
  SO_105/               ← propustek 2 (km 3,071)
  SO_106/106_1/         ← Nová Hospoda
  SO_107/               ← zpomalovací ostrůvek
```

## Konfigurace (uvnitř `index.html`)

```js
var MAPY_API_KEY      = 'n4vDG-...';                                   // mapy.cz API
var FIREBASE_URL      = 'https://sulice-zelivec-default-rtdb...';      // Realtime DB
var GITHUB_USER_REPO  = 'Pripravar/Sulice---Zelivec';                  // pro foto upload
var KM_START          = 0.000;
var KM_END            = 4.605;
```

## Aktualizace výkresů (PDPS → realizační dokumentace)

Až přijde realizační dokumentace, stačí:

1. Nahrát nové PDF do `pdf/SO_xxx/` (zachovat jména souborů, nebo upravit cesty v `DOCS_SITUACE`, `DOCS_PP`, … v `index.html`)
2. Commit + Push
3. GitHub Pages se aktualizuje automaticky během 1–2 minut

## Firebase pravidla

Test mode (default) běží 30 dní. Před vypršením nastav v Firebase Console → Realtime Database → Rules:

```json
{
  "rules": {
    ".read":  true,
    ".write": true
  }
}
```

## Kalibrace

GPS ↔ km mapování je nastaveno na 8 kalibračních bodů (`gps vs km.gpx`). Pro doladění je možné v `index.html` upravit pole `CALIB_POINTS`.

## Známé limity (PDPS)

- Pracovní příčné řezy (každých 20 m) — nejsou v PDPS, přijdou s realizační dokumentací
- Etapy výstavby — přijdou s harmonogramem realizační dokumentace
- Sanace podloží — pokud bude relevantní, doplní se z realizační dokumentace
