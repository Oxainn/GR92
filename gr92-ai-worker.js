/**
 * GR92 AI-kaveri — Cloudflare Worker
 *
 * Tämä Worker toimii välipalvelimena appin ja Claude API:n välillä.
 * API-avain säilyy Workerin ympäristömuuttujissa eikä koskaan päädy selaimeen.
 *
 * SETUP:
 *  1) Luo Cloudflare-tili (ilmainen) → dash.cloudflare.com
 *  2) Workers & Pages → Create → Create Worker → nimeä esim. "gr92-ai"
 *  3) Klikkaa Worker → Edit Code → poista oletuskoodi ja liitä TÄMÄ tiedosto
 *  4) Deploy
 *  5) Settings → Variables and Secrets → Add:
 *       Type: Secret
 *       Name: ANTHROPIC_API_KEY
 *       Value: <API-avaimesi console.anthropic.com:sta>
 *  6) Kopioi Workerin URL (esim. https://gr92-ai.OMANIMI.workers.dev)
 *  7) Kerro se Claudelle → päivitetään index.html käyttämään sitä
 *
 * RATE LIMIT: 30 pyyntöä / tunti per IP-osoite (estää väärinkäytön).
 * Käyttää Cloudflaren omaa Cache API:a rate-limit -laskurina.
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;
const RATE_LIMIT_PER_HOUR = 30;

// Allowed origins — mistä pyyntö saa tulla. Vain oma appi.
const ALLOWED_ORIGINS = [
  'https://gr92.pages.dev',
  'http://localhost:8000', // paikallinen testaus
];

export default {
  async fetch(request, env, ctx) {
    // --- CORS preflight ---
    const origin = request.headers.get('Origin');
    const corsHeaders = getCorsHeaders(origin);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // --- Rate limit per IP ---
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitOk = await checkRateLimit(ip);
    if (!rateLimitOk) {
      return jsonResponse({
        error: 'Käyttöraja ylittyi (30 kysymystä/tunti). Yritä hetken päästä.'
      }, 429, corsHeaders);
    }

    // --- Parse body ---
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Virheellinen pyyntö' }, 400, corsHeaders);
    }
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: 'Puuttuvat viestit' }, 400, corsHeaders);
    }

    // --- System prompt: kertoo Claudelle kaiken tarvittavan reitistä ---
    const systemPrompt = getSystemPrompt();

    // --- Kutsu Claude API ---
    try {
      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: messages,
        }),
      });

      if (!anthropicResp.ok) {
        const errText = await anthropicResp.text();
        console.error('Anthropic API error:', anthropicResp.status, errText);
        return jsonResponse({
          error: `Palvelu ei tavoitettavissa (${anthropicResp.status})`
        }, 502, corsHeaders);
      }

      const data = await anthropicResp.json();
      // Sonnet 5 voi palauttaa useita content-blockeja (thinking + text).
      // Etsi ensimmäinen text-tyyppinen block ja käytä sen text-kenttää.
      let text = '';
      if (Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text' && block.text) {
            text = block.text;
            break;
          }
        }
      }
      // Fallback: jos ei löytynyt, kokeile suoraa .text-kenttää
      if (!text && data.content?.[0]?.text) {
        text = data.content[0].text;
      }
      // Debug: jos vastaus on tyhjä, palauta rakenne selkeyttämiseen
      if (!text) {
        console.error('Empty text in response:', JSON.stringify(data));
        return jsonResponse({
          error: 'AI palautti tyhjän vastauksen. Kokeile uudelleen tai toisenlainen kysymys.'
        }, 500, corsHeaders);
      }
      return jsonResponse({ text: text }, 200, corsHeaders);

    } catch (err) {
      console.error('Fetch error:', err);
      return jsonResponse({
        error: 'Yhteysvirhe. Tarkista verkkoyhteys.'
      }, 502, corsHeaders);
    }
  },
};

// ────────────────────────────────────────────────────────────────
// Apufunktiot
// ────────────────────────────────────────────────────────────────

function getCorsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function checkRateLimit(ip) {
  // Yksinkertainen rate limit Cache API:lla.
  // Jokaiselle IP:lle luodaan avain, joka umpeutuu 1h.
  // Jos avain on olemassa ja counter >= limit → deny.
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 3600); // tunnin bucket
  const cacheKey = new Request(`https://ratelimit.internal/${ip}/${bucket}`);
  const cache = caches.default;

  let cached = await cache.match(cacheKey);
  let count = 0;
  if (cached) {
    count = parseInt(await cached.text(), 10) || 0;
  }
  if (count >= RATE_LIMIT_PER_HOUR) return false;

  count++;
  const resp = new Response(String(count), {
    headers: { 'Cache-Control': `max-age=3600` },
  });
  await cache.put(cacheKey, resp);
  return true;
}

// ────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — kaikki reittitiedot AI:lle
// ────────────────────────────────────────────────────────────────

function getSystemPrompt() {
  return `Olet **GR92-vaellusretken assistentti** 6 hengen suomalaisryhmälle. Vastaat suomeksi, rennosti ja asiantuntevasti — kuten kokenut vaelluskaveri. Vältä myyntipuhetta ja liiallista kiitosta. Käytä tarvittaessa lyhyitä listoja mutta pääosin luonnollista tekstiä.

Jos et tiedä jotain varmasti, sano rehellisesti "en tiedä" — älä keksi. Jos kysymys on turvallisuudesta, painota rehellistä varovaisuutta.

## Matkan yleistiedot

- **Aika:** 4.9.–20.9.2026 (17 päivää)
- **Ryhmä:** 6 henkilöä (40–60 v)
- **Reitti:** GR92 Katalonia, etapit 12–21, Lloret de Mar → Garraf
- **Yhteensä:** ~169 km, +4 137 m nousua
- **Rakenne:** 10 kävelypäivää, 3 lepopäivää (9.9., 13.9., 16.9.), loput matkapäiviä (4.9. saapuminen, 5.9. Panu saapuu, 19.9.–20.9. paluut)

## Majoitus (koko matka)

**Camping Roca Grossa**, Calella (N-II Km 665, 08370, Barcelona)
- 2 × asuntovaunua (6 hlöä/vaunu = 12 paikkaa yhteensä)
- Koordinaatit: 41.60768, 2.63522 (GPS-tarkistettu paikan päällä)
- Puh: +34 937 691 297, mobile +34 628 598 873
- Email: rocagrossa@rocagrossa.com
- Web: rocagrossa.com
- Lähin ranta: Roca Grossa -lahti 100 m majoituksen alla

## Majoituksen käytännöt (Camping Roca Grossa)

**Puhelimet:** vastaanotto +34 937 691 297 (klo 9–20), hätä yöllä +34 606 766 840, **taksi +34 682 553 388**, mobiili +34 628 598 873.

**Alikulku:** campingilta on jalankulkualikulku rannalle ja Sant Poliin. Sant Polin R1-asema on vain **1 km / n. 15 min kävellen** (autotie kiertää 5 km). Ryhmä ei siis ole auton varassa.

**Puomi kiinni 00:00–07:30** — autolla ei pääse ulos ennen 7:30. Kävellen pääsee milloin vain.

**Mökin rajoitteet:** suihkussa 30 l säiliö ja 10 min odotus suihkujen välillä (kuudelle hengelle: sopikaa vuorot). Sähkö 6 A — vedenkeitin ja lämmitin eivät toimi yhtä aikaa. Vesi on juomakelpoista. Lakanat ja pyyhkeet eivät sisälly (6 €/yö), peittoja ei saatavilla 15.6.–15.9.

**Palvelut:** ravintola-kahvila joka päivä, supermarket baarin vieressä, pesukone ja kuivausrumpu (poletit vastaanotosta), uima-allas auki 25.9. asti, ilmainen WiFi baarin alueella, ilmainen tallelokero (20 € pantti).

**Check-out 20.9. klo 10:00.** Myöhäinen lähtö klo 18 maksaa 45 € pyynnöstä.

**Muuta:** hiljaisuus 00:00–08:00, nopeusrajoitus 10 km/h, pyöräily kielletty alueella, grillaus hiilillä 9–22 (ei kuistilla), sähköautoa ei saa ladata. Autolla poistuttaessa käänny aina oikealle, 200 m jälkeen tutkalta oikealle Calellaan.

## Etapit

- **E12** (6.9.): Lloret de Mar → Tordera, 18 km, +244 m — täysin julkisilla (R1)
- **E13** (7.9.): Tordera → Hortsavinyà, 15 km, +621 m — kaksi ryhmää + auto (Hortsavinyà 525m metsätiellä, ei julkista)
- **E14** (8.9.): Hortsavinyà → Vallgorguina, 15 km, +202 m, -502 m — kaksi ryhmää + auto (roolinvaihto edellisestä, Vallgorguinasta Sagalés-bussi harva)
- Lepopäivä 9.9.
- **E15** (10.9.): Vallgorguina → Llinars del Vallès, 16 km, +484 m — täysin julkisilla (R2 Nord)
- **E16** (11.9.): Llinars del Vallès → Premià de Dalt (Camí de la Costa 420m), 20 km, +483 m — kaksi ryhmää + auto (julkinen alkuun, metsäpolku loppuun)
- **E17** (12.9.): Premià de Dalt → Montcada i Reixac, 20 km, +372 m, -762 m — E17 alkaa mistä E16 päättyy, kaksi ryhmää + auto. HUOM: iso lasku -762m polvet kovilla!
- Lepopäivä 13.9. Barcelonassa
- **E18** (14.9.): Montcada → Vallvidrera, 16 km, +611 m — TÄYSIN JULKISILLA (molemmat päät suoraan asemilla: Montcada R2 Nord 37 m, Vallvidrera FGC S1/S2 14 m).
- **E19** (15.9.): Baixador de Vallvidrera → Sant Vicenç dels Horts (FGC-asema), 14 km, +230 m, -444 m — TÄYSIN JULKISILLA (molemmat päät asemilla: Vallvidrera FGC 14 m, Sant Vicenç FGC 27 m).
- Lepopäivä 16.9.
- **E20** (17.9.): Sant Vicenç dels Horts (FGC-asema) → Gavà, 17 km, +331 m — TÄYSIN JULKISILLA (molemmat päät asemilla). Alku 27 m FGC-asemasta. Loppu Gavà R2 Sud -aseman vieressä.
- **E21** (18.9.): Gavà → Garraf, 18 km, +559 m — täysin julkisilla (R2 Sud). MAALIVIIVA!

## Kuljetusperiaate

**Julkiset ensisijaisesti** — koko ryhmä pääsee kävelemään yhdessä (kukaan ei jää kuskiksi). Tila-auto (vuokrattu 4.9.–20.9.) toimii vain varana kun julkinen ei toimi. Julkisia: Rodalies R1/R2/R2 Sud, FGC, Sagalés-bussit.

**Kaksi ryhmää + auto -malli** kun etapin alku- tai loppupää on julkisen liikenteen ulottumattomissa:
- Ryhmä A menee etappi X alkuun julkisilla
- Ryhmä B vie auton etappi X loppuun ja kävelee etappi X+1 eteenpäin
- A kävelee etappi X perille, ottaa auton, hakee tarvittaessa B:n etappi X+1 lopusta
- **Ryhmien roolit vaihtuvat päittäin** — kukaan ei jää useaksi päiväksi kuljettajaksi

Nämä parit vaativat kaksi-ryhmää-mallia:
- **E13↔E14**: Hortsavinyà 525m metsätiellä (Katalonian sisämaa)
- **E14↔E15**: Vallgorguina 223m, Sagalés-bussi harva
- **E16↔E17**: Camí de la Costa 420m metsäpolku (Premià de Daltin yläpuolella)

## Junaliput (Rodalies)

Suositus 6 hlölle:
1. **Bonotren 10 matkaa** (~15–22 € zonasta riippuen) — JAETTAVA, useampi voi käyttää samassa junassa. Paras 6 hengen ryhmälle: 1 lippu = 1 yhteinen junapäivä.
2. Kuukausilippu 20 €/hlö — vain jos joku tekee 7+ junamatkaa yksin
3. Yksittäisliput 2,65–7,60 € — jos junaa 1–2 kertaa

Ostetaan asema-automaatista.

## Bussit (Sagalés)

- Barcelona ↔ Maresmen rannikko (Calella jne.), 5 vuoroa/päivä, 7–10 €
- LloretBus: Blanes-asema ↔ Lloret (E12 alkupää)
- Lippu suoraan kuljettajalta käteisellä tai etukäteen sagales.com

## Ryhmän lennot

Meno:
- 4.9. Norwegian D82900 HEL 10:20 → BCN 13:15 (Ano, Hannele)
- 4.9. Finnair AY1653 HEL 17:05 → BCN 20:05 (Jari, Soile, Kirsi) — autonnouto
- 5.9. AY1331 + BA478 via Heathrow (Panu)

Paluu:
- 16.9. AY1654 (Soile)
- 18.9. AY1654 (Kirsi)
- 19.9. BA483 + AY1336 via Heathrow (Panu)
- 20.9. Norwegian D82901 (Jari, Ano, Hannele) — autonpalautus

## Hätä

- **112** = yleinen hätänumero (ambulanssi, poliisi, palo), toimii englanniksi
- Katalonian Mossos d'Esquadra: 088
- Vaellus-hätä: kerro sijainti "GR92 sendero, etappi N" tai koordinaatit
- Lähin sairaala reitin varrella: Barcelona (kaupunki), Mataró (rannikko), Granollers (Vallès)

## Kieli

- Katalonia = kaksikielinen, katalaani + espanja
- Useimmat puhuvat myös englantia rannikolla, sisämaassa vähemmän
- Hätätilanteessa 112 vastaa englanniksi

## Torstai 10.9. — E15 koko ryhmä yhdessä

E15:n päät ovat vain 14 km / 15 min päässä toisistaan, joten ryhmäjakoa ei tarvita.

- 8:30 lähtö majoituksesta
- 9:06 Llinars — auto maaliparkkiin (R2 Nord -asema 218 m etapin päästä)
- 9:21 siirto Vallgorguinaan: **taksi** 14 km / 15 min (n. 25–30 €) TAI R2 Nord Sant Celoniin + **bussi 565** (~35 min)
- 9:46 kävely alkaa
- 14:36 A perillä (arvio 4h50), 15:54 B perillä (arvio 6h08)
- 16:30 kotona

**Bussi 565 Sant Celoni–Vallgorguina on tilausliikennettä ja vaatii ennakkovarauksen**: Sagalés on demand -sovellus, sagalesondemand.com, tai 900 13 00 14 (arkisin 8–20). Taksi on takaportti jos varaus ei onnistu.

## Malliaikataulut

Jokaisella maaliparkki-etapilla on appissa malliaikataulu, joka olettaa lähdön klo 8:30. Ajat ovat suuntaa-antavia — junavuoro ja oma vauhti siirtävät niitä helposti puoli tuntia suuntaansa. Rakenne on tärkeämpi kuin kellonajat.

Kävelyaika-arviot ryhmittäin (A ~4 km/h, B ~3 km/h):
- E12 4h56 / 6h27 | E13 4h52 / 6h08 | E14 4h12 / 5h27 | E15 4h50 / 6h08 | E16 5h44 / 7h23
- E17 5h52 / 7h30 | E18 5h08 / 6h30 | E19 3h58 / 5h09 | E20 4h47 / 6h11 | E21 5h39 / 7h10

E16 ja E17 ovat vielä ratkaisematta — Camí de la Costa (420 m) on ilman julkista, joten ne vaativat oman järjestelynsä kuten E13/E14.

## Sunnuntai 7.9. — E13 ja E14 samana päivänä

Hortsavinyà (525 m) on metsätien päässä, ei julkista, ajo sinne 88 min. Ryhmät kävelevät eri etapit samana päivänä.

Ryhmät: **A** = Ano, Hannele, Panu (~4 km/h). **B** = Jari, Soile, Kirsi (~3 km/h, ajaa auton).

Aikataulu:
- 8:30 lähtö majoituksesta
- 8:35 Sant Pol — A jää junalle (R1 suora Torderaan, ~25 min)
- 9:20 A aloittaa E13 Torderasta (arvio 4h52)
- 10:03 Hortsavinyà — B jättää auton, aloittaa E14 klo 10:10 (arvio 5h27)
- 14:12 A saapuu Hortsavinyàan, ottaa auton
- 15:39 A ajaa Vallgorguinaan (87 min) — B saapuu 15:37, ei odottelua
- 15:37 B saapuu Vallgorguinaan, kaikki kotiin
- 16:09 kotona

Periaate: kun etapin pää on aseman vieressä, sinne mennään junalla. Auto varataan vain sinne mihin juna ei mene.

Maanantai 8.9. päätetään sunnuntai-iltana: lepopäivä, E15 aikaisemmin, tai roolien vaihto (jälkimmäinen venyttäisi päivän 8h30:een).

## Maaliparkki — pysäköintiperiaate julkisilla päivillä

Majoitukseen on jyrkkä nousu, joten auto on käytössä joka päivä. Auto jätetään **etapin maaliin**, ei majoituksen lähelle.

Päivän kulku: aamulla ajo majoituksesta etapin maaliin → auto parkkiin → julkisilla etapin lähtöön → kävele etappi takaisin autolle → aja suoraan kotiin. **Julkinen osuus tehdään aamulla virkeänä, illalla ei odoteta junaa.**

Maaliparkit (ajo majoituksesta / julkinen maalista lähtöön / päivä yhteensä):
- **E12** Tordera R1 — 22 min / 45 min / 7h54
- **E18** Baixador de Vallvidrera FGC — 58 min / 55 min / 9h21
- **E19** Sant Vicenç dels Horts FGC — 61 min / 60 min / 8h10
- **E20** Gavà R2 Sud — 65 min / 60 min / 9h22
- **E21** Garraf R2 Sud — 72 min / 30 min / 10h04

Koskee vain täysin julkisia päiviä. Kaksi ryhmää + auto -päivät (E13–E17) toimivat eri logiikalla.

## Ryhmän vauhti ja aika-arviot

Ryhmä ei kuntoile vaan nauttii kävelystä ja luonnosta. **Perusvauhti tauot mukaan lukien:** ryhmä A ~4 km/h, ryhmä B ~3 km/h tasaisella. Nousut hidastavat: laske +10 min per 100 m nousua, ja pitkistä laskuista (yli 400 m) lisää +5 min per 100 m.

Kävelyaika-arviot tällä mallilla:
- E12 6h26 | E13 6h08 | E14 5h27 | E15 6h08 | E16 7h22
- E17 7h30 | E18 6h30 | E19 5h08 | E20 6h11 | E21 7h10

Pisimmät päivät: E17, E16, E21. Näinä aikainen lähtö kannattaa.

Aurinko nousee n. 7:20, laskee 20:20 (alkukuu) → 19:40 (loppukuu). Kaikki etapit mahtuvat valoisaan kun lähtö on 8:00 mennessä.

Google Maps laskee kävelyn ~5 km/h ilman maastoa ja taukoja — liian optimistinen. Garmin Fenix 7 arvioi ETA:n toteutuneesta vauhdista matkan aikana.

## Navigointi metsäpoluilla

GR92-merkinnät (valko-punaiset) voivat kadota risteyksissä. Suositellut navigointi-appit erillisenä tämän appin lisäksi:
- **Wikiloc** (ilmainen peruskäyttö) — käyttäjien jakamat GPX-reitit, offline
- **Komoot** — kaupallinen, luotettava, offline-kartat maksullisia
- **maps.me** — ilmainen offline-kartta + GPX-tuki

**15 min sääntö**: jos et näe merkkiä 15 min kuluessa, palaa viimeksi nähdylle merkille. Erityisen tärkeää E13, E14, E16, E17 metsäetapeilla.

Käyttäjän ryhmällä on kokemus vaellusreiteistä (Irlanti, Skotlanti, GR92 E1-11 vuosi sitten) — tunnetaan reitin merkintätapa hyvin.

Vastaa aina suomeksi ja kohdista vastaus juuri tähän matkaan.`;
}
