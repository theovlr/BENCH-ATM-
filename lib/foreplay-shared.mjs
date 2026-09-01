// Fonctions Foreplay Spyder + classification partagées, extraites de run-report.mjs.
// run-report.mjs garde sa propre copie inline (il n'est pas modifié) : ce module
// est la référence pour tout nouveau script (ex: benchmark-ugc.mjs) qui veut
// réutiliser ces fonctions sans les redupliquer.

import { normalizeAd } from './normalize.mjs';

const FOREPLAY_API_KEY = process.env.FOREPLAY_API_KEY;
const FOREPLAY_BASE    = 'https://public.api.foreplay.co';

const DEFAULT_MAX_ADS_PER_BRAND = parseInt(process.env.MAX_ADS_PER_BRAND || '250', 10);

// Marques ATM Gaming — séparées des concurrents pour la section "Mes Perfs"
export const OWN_BRAND_KEYWORDS = ['quickstop', 'pili pili', 'speedbac', 'smash it', 'jumo',
  'play hit', 'mouton mouton', 'little secret', 'ranking', 'atm gaming'];

// Marques hors industrie à ignorer dans l'analyse (dating, food, beauty...)
export const IRRELEVANT_KEYWORDS = ['meetic', 'tinder', 'paired', 'fruitz', 'air up', 'poppi',
  'holy energy', 'naali', 'my lubie', 'melba', 'happn', 'badoo', 'hinge', 'bumble',
  'omgyes', 'prepmymeal', 'hydratis'];

// Classification pays par nom de marque (ordre important : plus spécifique en premier)
export const COUNTRY_RULES = [
  { country: 'it',     keywords: ['clementoni', 'cranio creations', 'ghenos', 'yaqua giochi', 'hilarus', 'sefirot', 'io sono te', 'fler world', 'yasgames'] },
  { country: 'es',     keywords: ['devir', 'diset', 'gcatalan', 'maldito', 'gen x games', 'ediciones mas', 'sd games'] },
  { country: 'nl',     keywords: ['999 games', 'jumbo games', 'white goblin', 'identity games', 'just games'] },
  { country: 'fr',     keywords: ['gigamic', 'bakakou', 'traitres', 'savana', 'olé mains', 'ole mains', 'fabriquedejeux', 'dossiers criminels', 'emblemes', 'emblèmes'] },
  { country: 'dach',   keywords: ['yaqua', 'crack games', 'crack list', 'holy ', 'weplay'] },
  { country: 'uk',     keywords: ['big potato', 'bigpotato'] },
  { country: 'us',     keywords: ['wdym', 'what do you meme', 'hitster', 'kollide', 'feastables'] },
  { country: 'global', keywords: ['lego', 'mattel', 'uno', 'hasbro', 'asmodee', 'ravensburger', 'naali', 'axel arigato'] },
];

export function classifyCountry(brandName) {
  const n = (brandName || '').toLowerCase();
  for (const { country, keywords } of COUNTRY_RULES) {
    if (keywords.some(kw => n.includes(kw))) return country;
  }
  return 'global';
}

export function isOwnBrand(name) {
  const n = (name || '').toLowerCase();
  return OWN_BRAND_KEYWORDS.some(kw => n.includes(kw));
}

export function isIrrelevant(name) {
  const n = (name || '').toLowerCase();
  return IRRELEVANT_KEYWORDS.some(kw => n.includes(kw));
}

// ─── Foreplay API ──────────────────────────────────────────────────────────────

export async function foreplayGet(path, params = {}) {
  const url = new URL(FOREPLAY_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${FOREPLAY_API_KEY}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Foreplay ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// Pagination dynamique : on avance par pages de 20 tant que l'API renvoie des
// résultats, au lieu de figer un nombre de pages en dur (le compte Spyder peut
// suivre plus de marques que ce qu'un nombre de pages fixe laisserait remonter).
// Garde-fou à 500 marques pour éviter une boucle infinie en cas de comportement
// inattendu de l'API.
export async function getSpyderBrands() {
  const limit = 10; // l'API Foreplay Spyder plafonne "limit" à 10 (erreur 422 au-delà)
  const maxBrands = 500;
  let offset = 0;
  const all = [];
  while (offset < maxBrands) {
    const page = await foreplayGet('/api/spyder/brands', { limit, offset });
    const brands = page.brands || page.data || page || [];
    if (!brands.length) break;
    all.push(...brands);
    if (brands.length < limit) break;
    offset += limit;
  }
  return all;
}

// Statut live : l'API Foreplay n'a pas de champ confirmé dans le mapping d'origine
// (run-report.mjs ne le capturait pas). On tente les noms de champs plausibles ;
// à défaut on renvoie null ("statut inconnu") plutôt que d'inventer une valeur.
function resolveLiveStatus(ad) {
  if (typeof ad.live === 'boolean') return ad.live;
  if (typeof ad.is_active === 'boolean') return ad.is_active;
  if (typeof ad.isActive === 'boolean') return ad.isActive;
  if (typeof ad.status === 'string') return ad.status.toLowerCase() === 'active';
  return null;
}

// Pagination par curseur sur /api/spyder/brand/ads (spec §3.2 : limit jusqu'à 250,
// metadata.cursor pour continuer). Retombe sur un limit plus bas si l'API rejette
// la valeur demandée (même défense que getSpyderBrands pour /api/spyder/brands).
export async function getBrandAdsRaw(brandId, { maxAds = DEFAULT_MAX_ADS_PER_BRAND } = {}) {
  let limit = Math.min(maxAds, 250);
  let cursor = null;
  const all = [];
  while (all.length < maxAds) {
    const params = { brand_id: brandId, limit, order: 'longest_running' };
    if (cursor) params.cursor = cursor;
    let page;
    try {
      page = await foreplayGet('/api/spyder/brand/ads', params);
    } catch (err) {
      if (limit > 10 && /422/.test(err.message)) { limit = 10; continue; }
      throw err;
    }
    const ads = page.ads || page.data || [];
    all.push(...ads);
    cursor = page.metadata?.cursor || null;
    if (!cursor || !ads.length) break;
  }
  return all.slice(0, maxAds);
}

// Forme héritée, conservée pour run-report.mjs qui ne connaît pas le schéma Ad
// canonique. En interne, corrige les bugs days_active/hook_text en passant par
// normalizeAd plutôt que par des noms de champs qui n'existent pas dans l'API.
export async function getBrandAds(brandId) {
  const rawAds = await getBrandAdsRaw(brandId, { maxAds: 20 });
  return rawAds.map(rawAd => {
    const ad = normalizeAd(rawAd, { id: null, name: null, avatar: null, ad_library_id: null });
    return {
      id: ad.id,
      format: ad.format,
      platforms: ad.publisher_platform,
      days_active: ad.running_days,
      start_date: ad.started_running,
      hook_text: ad.hook,
      img: ad.thumbnail || '',
      url: ad.foreplay_url,
      live: ad.live,
    };
  });
}
