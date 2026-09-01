// Raw API Foreplay (brand + ad) -> schéma Ad canonique (spec SPEC-BENCHMARK-V2.md §4.3).
// Pur : aucun appel réseau ici. owner/atm_product/market/market_confidence/market_source/in_scope
// sont laissés à null : ils sont renseignés par classify.mjs, qui a besoin de la config des
// marques ATM et des règles de marché — normalize.mjs n'en dépend pas.

const KNOWN_FORMATS = new Set(['VIDEO', 'IMAGE', 'CAROUSEL', 'DCO', 'DPA']);
const HOOK_MAX_WORDS = 12;

export function normalizeFormat(rawFormat) {
  const upper = (rawFormat || '').toUpperCase();
  return KNOWN_FORMATS.has(upper) ? upper : 'OTHER';
}

// Cascade imposée par la spec §2.2 : headline -> description -> title -> name ->
// premiers mots de la transcription -> chaîne vide. Ne jamais recopier une transcription
// entière comme hook (elle peut faire plusieurs paragraphes) : on ne garde que les
// premiers mots, à l'image d'une accroche de 3 secondes.
export function resolveHook(rawAd) {
  if (rawAd.headline) return rawAd.headline;
  if (rawAd.description) return rawAd.description;
  if (rawAd.title) return rawAd.title;
  if (rawAd.name) return rawAd.name;
  const transcription = rawAd.transcription || rawAd.full_transcription;
  if (transcription) return transcription.trim().split(/\s+/).slice(0, HOOK_MAX_WORDS).join(' ');
  return '';
}

function toIsoOrNull(epochMs) {
  return typeof epochMs === 'number' ? new Date(epochMs).toISOString() : null;
}

// Cascade héritée de l'ancien resolveLiveStatus (lib/foreplay-shared.mjs, pré-lot 1) :
// l'API Foreplay n'a pas de champ "live" confirmé dans toutes ses réponses ; on tente
// les noms de champs plausibles avant de retomber sur null ("statut inconnu") plutôt
// que d'inventer une valeur. Ne pas réduire cette cascade à un simple test sur
// rawAd.live : ça ferait régresser silencieusement le statut live affiché par
// run-report.mjs (via getBrandAds, lib/foreplay-shared.mjs) pour toute pub dont le
// statut n'arrive que sous is_active/isActive/status.
function resolveLive(rawAd) {
  if (typeof rawAd.live === 'boolean') return rawAd.live;
  if (typeof rawAd.is_active === 'boolean') return rawAd.is_active;
  if (typeof rawAd.isActive === 'boolean') return rawAd.isActive;
  if (typeof rawAd.status === 'string') return rawAd.status.toLowerCase() === 'active';
  return null;
}

export function normalizeAd(rawAd, rawBrand) {
  return {
    id: rawAd.id,
    ad_id: rawAd.ad_id ?? null,
    foreplay_url: rawAd.foreplay_url || `https://app.foreplay.co/discovery?ad=${rawAd.id}`,
    ad_library_url: rawAd.ad_library_url ?? null,

    brand_id: rawBrand.id,
    brand_name: rawBrand.name,
    brand_avatar: rawBrand.avatar ?? null,
    page_id: rawBrand.ad_library_id ?? null,

    owner: null,
    atm_product: null,
    market: null,
    market_confidence: null,
    market_source: null,
    in_scope: null,

    format: normalizeFormat(rawAd.display_format),
    headline: rawAd.headline ?? '',
    description: rawAd.description ?? '',
    hook: resolveHook(rawAd),
    transcription: rawAd.transcription ?? rawAd.full_transcription ?? null,
    video_duration: rawAd.video_duration ?? null,
    cta_type: rawAd.cta_type ?? null,
    cta_title: rawAd.cta_title ?? null,
    link_url: rawAd.link_url ?? null,
    thumbnail: rawAd.thumbnail ?? null,
    media_url: rawAd.video ?? rawAd.image ?? null,

    emotional_drivers: rawAd.emotional_drivers ?? null,
    persona: rawAd.persona ?? null,
    niches: rawAd.niches ?? [],
    product_category: rawAd.product_category ?? null,
    market_target: rawAd.market_target ?? null,
    languages: rawAd.languages ?? [],
    publisher_platform: rawAd.publisher_platform ?? [],

    live: resolveLive(rawAd),
    // Choix explicite de la spec §2.1 : ?? 0, pas null. running_duration est présent sur
    // quasi toutes les pubs actives ; le garde-fou de qualité (metrics.nullLongevityRate,
    // Task 4) mesure le taux de running_days === 0 pour détecter une vraie régression.
    running_days: rawAd.running_duration?.days ?? 0,
    started_running: toIsoOrNull(rawAd.started_running),
    ranking: null, // endpoint rankings non appelé en lot 1 (lot 5)

    first_seen: new Date().toISOString().split('T')[0],
    last_seen: new Date().toISOString().split('T')[0],
  };
}
