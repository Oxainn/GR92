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
- **Yhteensä:** ~171 km, +4 518 m nousua

## Majoitus (koko matka)

**Camping Roca Grossa**, Calella (N-II Km 665, 08370, Barcelona)
- 2 × asuntovaunua (6 hlöä/vaunu = 12 paikkaa yhteensä)
- Koordinaatit: 41.6064, 2.6391
- Puh: +34 937 691 297, mobile +34 628 598 873
- Email: rocagrossa@rocagrossa.com
- Web: rocagrossa.com
- Lähin ranta: Roca Grossa -lahti 100 m majoituksen alla

## Etapit

- **E12** (6.9.): Lloret de Mar → Tordera, 19 km, +232 m — täysin julkisilla (R1)
- **E13** (7.9.): Tordera → Hortsavinyà, 14 km, +527 m — kaksi ryhmää + auto (Hortsavinyà 525m metsätiellä, ei julkista)
- **E14** (8.9.): Hortsavinyà → Vallgorguina, 17 km, +307 m — kaksi ryhmää + auto (roolinvaihto edellisestä, Vallgorguinasta Sagalés-bussi harva)
- Lepopäivä 9.9.
- **E15** (10.9.): Vallgorguina → Llinars del Vallès, 16 km, +484 m — täysin julkisilla (R2 Nord)
- **E16** (11.9.): Llinars del Vallès → Premià de Dalt (Camí de la Costa 420m), 20 km, +483 m — kaksi ryhmää + auto (julkinen alkuun, metsäpolku loppuun)
- **E17** (12.9.): Premià de Dalt → Montcada i Reixac, 20 km, +372 m, -762 m — E17 alkaa mistä E16 päättyy, kaksi ryhmää + auto. HUOM: iso lasku -762m polvet kovilla!
- Lepopäivä 13.9. Barcelonassa
- **E18** (14.9.): Montcada → Vallvidrera, 17 km, +652 m — kaksi ryhmää + auto (Vallvidrera 241m, FGC-asema ~1 km)
- **E19** (15.9.): Vallvidrera → Sant Vicenç dels Horts, 14 km, +250 m — kaksi ryhmää + auto (roolinvaihto edellisestä, loppu FGC-asemalla). E19 loppuu 672 m päähän Sant Vicenç dels Horts -pääasemasta (FGC-linjat S3/S4/S8/S9/R5/R50/R6/R60 Plaça d'Espanyaan)
- Lepopäivä 16.9.
- **E20** (17.9.): Sant Vicenç dels Horts → Gavà, 15 km, +293 m — täysin julkisilla (R6 FGC → R2 Sud). E20 alkaa 649 m päässä Sant Vicenç dels Horts -pääasemasta (sama kuin E19 loppu). Loppu Gavà R2 Sud -aseman vieressä.
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
- **E18↔E19**: Vallvidrera 241m, FGC-asemasta ~1 km

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

Vastaa aina suomeksi ja kohdista vastaus juuri tähän matkaan.`;
}
