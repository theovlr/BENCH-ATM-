// lib/classify.mjs
// Classification marché (cascade), tag ATM/concurrent, et périmètre sectoriel.
// Pur : pas d'appel réseau. Remplace COUNTRY_RULES-only et isOwnBrandExtended
// (SPEC-BENCHMARK-V2.md §2.4, §2.5, §4.3).

const LANGUAGE_TO_MARKET = {
  // Anglais volontairement absent : ambigu entre uk/us/global, on laisse la cascade
  // continuer vers link_url / website TLD plutôt que de deviner.
  French: 'fr', German: 'dach', Italian: 'it', Spanish: 'es', Dutch: 'nl',
};

const TLD_TO_MARKET = {
  fr: 'fr', de: 'dach', at: 'dach', ch: 'dach',
  uk: 'uk', 'co.uk': 'uk', it: 'it', es: 'es', nl: 'nl',
};

// Règle de marché par mot-clé de marque, dernier recours de la cascade.
// Corrige les 10 erreurs listées dans SPEC-BENCHMARK-V2.md §2.4.
const BRAND_MARKET_RULES = [
  { market: 'it', keywords: ['clementoni', 'cranio creations', 'ghenos', 'yaqua giochi', 'hilarus',
    'sefirot', 'io sono te', 'fler world', 'yasgames', 'giochi uniti', 'rocco giocattoli'] },
  { market: 'es', keywords: ['devir', 'diset', 'gcatalan', 'maldito', 'gen x games', 'ediciones mas', 'sd games'] },
  { market: 'nl', keywords: ['999 games', 'jumbo games', 'jumboplay', 'white goblin', 'identity games', 'just games'] },
  { market: 'fr', keywords: ['gigamic', 'bakakou', 'traitres', 'savana', 'olé mains', 'ole mains',
    'fabriquedejeux', 'dossiers_criminels', 'dossiers criminels', 'emblemes', 'emblèmes',
    'le plus proche gagne', 'dimoi'] },
  { market: 'dach', keywords: ['yaqua spiele', 'yaqua jouer', 'crack games', 'crack list', 'weplay'] },
  { market: 'uk', keywords: ['big potato', 'bigpotato', 'outsmarted', 'asmodee uk'] },
  { market: 'us', keywords: ['wdym', 'what do you meme', 'hitster', 'kollide', 'exploding kittens'] },
  { market: 'global', keywords: ['lego', 'mattel', 'uno', 'hasbro', 'ravensburger'] },
];

// Secteur jeu de société / entertainment. Vérifié en priorité sur les champs API
// (niches, product_category, category) — la liste noire ne reste qu'un filet de
// sécurité (spec §2.5), plus une source de vérité.
const IN_SCOPE_NICHES = ['game', 'entertainment', 'toys'];
const IRRELEVANT_KEYWORDS = ['meetic', 'tinder', 'paired', 'fruitz', 'air up', 'poppi',
  'holy', 'naali', 'my lubie', 'melba', 'happn', 'badoo', 'hinge', 'bumble',
  'omgyes', 'prepmymeal', 'hydratis'];

function normName(name) {
  return (name || '').toLowerCase().replace(/_/g, ' ');
}

function extractTld(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.co.uk')) return 'co.uk';
    const parts = host.split('.');
    return parts[parts.length - 1];
  } catch {
    return null;
  }
}

// Code marché en suffixe du dernier segment de chemin (ex: /pilipili-uk -> "uk").
// Volontairement strict : suffixe exact de 2 lettres en fin de segment, jamais une
// recherche de sous-chaîne sur l'URL complète (voir commentaire d'appel).
// Limitation connue, acceptée : un code 2 lettres qui coïncide avec un mot anglais courant
// en fin de segment URL (ex: "pilipili-win-it") sera mal interprété comme code marché (ex: "it").
// Pas de denylist de mots courants — c'est disproportionné. Le signal reste à confidence 'medium'
// (jamais 'high'), donc une mauvaise classification est visible et corrigible via ce champ.
function lastPathSegmentMarketCode(url) {
  if (!url) return null;
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
  const match = lastSegment.toLowerCase().match(/-([a-z]{2})$/);
  return match ? match[1] : null;
}

export function classifyMarket(ad, brand) {
  const [language] = ad.languages || [];
  if (language && LANGUAGE_TO_MARKET[language]) {
    return { market: LANGUAGE_TO_MARKET[language], market_confidence: 'high', market_source: 'language' };
  }

  const linkTld = extractTld(ad.link_url);
  if (linkTld && TLD_TO_MARKET[linkTld]) {
    return { market: TLD_TO_MARKET[linkTld], market_confidence: 'medium', market_source: 'link_url' };
  }
  // Repli spec §3.2 : atmgaming.com/pilipili-uk porte le marché dans le DERNIER
  // segment du chemin, en suffixe après un tiret. On ne fait volontairement pas de
  // recherche de sous-chaîne sur l'URL entière : "holy-sheep-at-home" contient "-at"
  // sans rapport avec l'Autriche, un substring match sur toute l'URL la classerait
  // à tort en dach. On n'accepte le code que s'il est exactement le suffixe du
  // dernier segment de chemin.
  const pathTld = lastPathSegmentMarketCode(ad.link_url);
  if (pathTld && TLD_TO_MARKET[pathTld]) {
    return { market: TLD_TO_MARKET[pathTld], market_confidence: 'medium', market_source: 'link_url' };
  }

  for (const website of brand.websites || []) {
    const tld = extractTld(website);
    if (tld && TLD_TO_MARKET[tld]) {
      return { market: TLD_TO_MARKET[tld], market_confidence: 'medium', market_source: 'website_tld' };
    }
  }

  const n = normName(brand.name);
  for (const { market, keywords } of BRAND_MARKET_RULES) {
    if (keywords.some(kw => n.includes(kw))) {
      return { market, market_confidence: 'low', market_source: 'brand_keyword' };
    }
  }

  return { market: 'unclassified', market_confidence: 'low', market_source: 'default' };
}

export function classifyOwner(brandName, atmBrandsConfig) {
  const n = normName(brandName);
  const match = atmBrandsConfig.find(({ keyword }) => n.includes(keyword));
  return match ? { owner: 'atm', atm_product: match.product } : { owner: 'competitor', atm_product: null };
}

export function classifyInScope(ad, brand) {
  const niches = (ad.niches || []).map(x => x.toLowerCase());
  const category = (brand.category || '').toLowerCase();
  const productCategory = (ad.product_category || '').toLowerCase();

  const looksInScope =
    niches.some(n => IN_SCOPE_NICHES.some(k => n.includes(k))) ||
    IN_SCOPE_NICHES.some(k => category.includes(k)) ||
    IN_SCOPE_NICHES.some(k => productCategory.includes(k));

  const n = normName(brand.name);
  const blacklisted = IRRELEVANT_KEYWORDS.some(kw => n.includes(kw));

  return looksInScope && !blacklisted;
}

export function classifyAd(ad, brand, atmBrandsConfig) {
  return {
    ...ad,
    ...classifyMarket(ad, brand),
    ...classifyOwner(brand.name, atmBrandsConfig),
    in_scope: classifyInScope(ad, brand),
  };
}
