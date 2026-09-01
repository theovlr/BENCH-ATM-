// ATM Gaming — Benchmark pubs concurrentes + génération d'idées UGC
// Réutilise les fonctions Foreplay/classification de lib/foreplay-shared.mjs
// (extraites de run-report.mjs, qui reste inchangé).

import OpenAI from 'openai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import atmBrandsConfig from './config/atm-brands.json' with { type: 'json' };
import { getSpyderBrands, getBrandAdsRaw } from './lib/foreplay-shared.mjs';
import { normalizeAd } from './lib/normalize.mjs';
import { classifyAd } from './lib/classify.mjs';
import { nullLongevityRate, emptyHookRate } from './lib/metrics.mjs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ATM_CATALOG = [
  'Speedbac', 'Pili Pili', 'JUMO', 'Quickstop', 'Mouton Mouton (Holy Sheep)',
  'Smash It', 'Play-Hit', 'Little Secret', 'Rank King', 'Osmooz', 'Intimoos',
];

const MARKETS = ['fr', 'dach', 'uk', 'us', 'it', 'es', 'nl', 'global'];

// ─── Nettoyage texte (sécurité en plus de la consigne dans le prompt) ───────────

function stripEmDash(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\s*—\s*/g, ', ').replace(/—/g, ', ');
}

function sanitizeDeep(value) {
  if (typeof value === 'string') return stripEmDash(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

// ─── Collecte des données Foreplay ─────────────────────────────────────────────

// Récupère TOUTES les marques Spyder (aucun filtre en amont : les marques ATM ne
// sont plus retirées, elles sont taguées owner:'atm' par classifyAd) et retourne
// un tableau PLAT de pubs classifiées (schéma Ad canonique). Les regroupements par
// marché/marque pour le dashboard HTML existant sont dérivés plus tard par
// buildBenchmarkView, jamais figés ici (spec §4.3).
async function fetchBenchmarkData() {
  console.log('📡 Récupération des marques Foreplay Spyder...');
  const allBrands = await getSpyderBrands();
  console.log(`  → ${allBrands.length} marques trouvées`);

  const results = await Promise.allSettled(allBrands.map(async brand => {
    const rawAds = await getBrandAdsRaw(brand.id, { maxAds: 250 });
    const ads = rawAds
      .map(rawAd => normalizeAd(rawAd, brand))
      .map(ad => classifyAd(ad, brand, atmBrandsConfig));
    return ads;
  }));

  const failedBrands = results.filter(r => r.status === 'rejected').length;
  if (failedBrands) console.warn(`⚠️  ${failedBrands} marque(s) non récupérée(s) (non bloquant)`);

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

// ─── Dérivation du regroupement par marché pour le dashboard HTML existant ─────

// Reconstruit EXACTEMENT l'ancienne forme { [market]: { brands: [...], topPerformers: [...] } }
// attendue par analyzeTrends/analyzeUGC/buildTaglinesCompetitors/generateHTML, à
// partir du tableau plat `ads` (classifié par classifyAd). Le dashboard "Pubs
// concurrentes" ne montre que les concurrents en périmètre (in_scope:true et
// owner:'competitor'), comme le faisait l'ancien filtre isOwnBrandExtended/isIrrelevant ;
// le dataset canonique complet (ATM inclus, hors-périmètre inclus) reste écrit à part
// dans data/dataset-<date>.json par main().
function buildBenchmarkView(ads) {
  const competitorAds = ads.filter(ad => ad.in_scope === true && ad.owner === 'competitor');

  // Regroupement par marché : { fr: { brands: [...] }, dach: { brands: [...] }, ... }
  const benchmark = {};
  for (const market of MARKETS) benchmark[market] = { brands: [] };

  for (const ad of competitorAds) {
    const market = ad.market;
    if (!benchmark[market]) benchmark[market] = { brands: [] };
    let brand = benchmark[market].brands.find(b => b.name === ad.brand_name);
    if (!brand) {
      brand = { name: ad.brand_name, market, ads: [] };
      benchmark[market].brands.push(brand);
    }
    brand.ads.push({
      id: ad.id,
      format: ad.format,
      days_active: ad.running_days,
      live: ad.live,
      hook_text: ad.hook,
      url: ad.foreplay_url,
    });
  }

  // Top performers par marché : live d'abord, puis jours actifs décroissants
  // (days_active porte désormais la vraie valeur running_days, plus jamais 0 en dur).
  for (const market of MARKETS) {
    const flatAds = benchmark[market].brands.flatMap(b =>
      b.ads.map(ad => ({ ...ad, brand: b.name, market })));
    flatAds.sort((a, b) => (b.live === true) - (a.live === true) || (b.days_active || 0) - (a.days_active || 0));
    benchmark[market].topPerformers = flatAds.slice(0, 8);
  }

  return benchmark;
}

// ─── Analyse Claude : tendances par marché ─────────────────────────────────────

async function analyzeTrends(client, benchmark) {
  const trimmed = {};
  for (const market of MARKETS) {
    trimmed[market] = benchmark[market].topPerformers.slice(0, 6).map(ad => ({
      brand: ad.brand, adId: ad.id, format: ad.format, days_active: ad.days_active,
      live: ad.live, hook: (ad.hook_text || '').substring(0, 200), url: ad.url,
    }));
  }

  const totalAds = Object.values(trimmed).reduce((n, arr) => n + arr.length, 0);
  console.log(`🤖 Analyse des tendances (${totalAds} top pubs, ${MARKETS.length} marchés)...`);

  const prompt = `Tu es expert en veille publicitaire pour ATM Gaming (éditeur de jeux de société).

Voici les meilleures pubs concurrentes actuelles (top performers), regroupées par marché :

${JSON.stringify(trimmed, null, 2)}

Pour chaque marché, dégage 3 à 5 tendances créatives récurrentes chez les concurrents qui performent : angle marketing, format dominant, structure de hook, thématique. Appuie chaque tendance sur des preuves concrètes (marques et adId réellement présents dans les données ci-dessus, jamais inventés).

Règles :
1. N'invente aucune marque ni aucun adId : utilise uniquement ceux fournis.
2. Si un marché n'a aucune donnée, retourne un tableau vide pour ce marché.
3. Tout le texte en français.
4. N'utilise JAMAIS le tiret cadratin (—). Utilise une virgule, un deux-points ou des parenthèses à la place.
5. Ne recopie pas un hook mot pour mot dans "description" : décris le pattern, ne le paraphrase pas comme s'il s'agissait du texte exact.`;

  const trendSchema = {
    type: 'array',
    items: {
      type: 'object',
      required: ['title', 'angle', 'dominantFormat', 'hookStructure', 'theme', 'description', 'evidence'],
      properties: {
        title: { type: 'string' },
        angle: { type: 'string' },
        dominantFormat: { type: 'string' },
        hookStructure: { type: 'string' },
        theme: { type: 'string' },
        description: { type: 'string' },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            required: ['brand', 'adId', 'url'],
            properties: { brand: { type: 'string' }, adId: { type: 'string' }, url: { type: 'string' } },
          },
        },
      },
    },
  };

  const properties = {};
  for (const market of MARKETS) properties[market] = trendSchema;

  const response = await client.chat.completions.create({
    model: 'gpt-4.1',
    max_tokens: 12000,
    tools: [{
      type: 'function',
      function: {
        name: 'publish_trends',
        description: 'Publie les tendances créatives concurrentes par marché',
        parameters: { type: 'object', required: MARKETS, properties },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'publish_trends' } },
    messages: [{ role: 'user', content: prompt }],
  });

  const choice = response.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('OpenAI a atteint la limite de tokens sur l\'analyse des tendances.');
  }
  const toolCall = choice.message.tool_calls?.find(c => c.function?.name === 'publish_trends');
  if (toolCall) return sanitizeDeep(JSON.parse(toolCall.function.arguments));

  let text = (choice.message.content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return sanitizeDeep(JSON.parse(text));
}

// ─── Analyse Claude : idées UGC ────────────────────────────────────────────────

async function analyzeUGC(client, benchmark) {
  const allTopPerformers = MARKETS.flatMap(market =>
    benchmark[market].topPerformers.slice(0, 5).map(ad => ({
      brand: ad.brand, market, adId: ad.id, format: ad.format,
      days_active: ad.days_active, live: ad.live,
      hook: (ad.hook_text || '').substring(0, 180), url: ad.url,
    })));

  console.log(`🤖 Génération des idées UGC (${allTopPerformers.length} top pubs tous marchés)...`);

  const prompt = `Tu es directeur créatif UGC pour ATM Gaming, éditeur de jeux de société. Catalogue de produits ATM disponible pour les concepts :
${ATM_CATALOG.map(p => `- ${p}`).join('\n')}

Voici les meilleures pubs concurrentes tous marchés confondus (top performers, jeux de société / entertainment) :

${JSON.stringify(allTopPerformers, null, 2)}

Analyse ces pubs et dégage les points communs qui reviennent chez PLUSIEURS concurrents performants différents (même angle marketing, même structure de hook, même promesse, même format). Pour chaque point commun identifié, propose 2 à 3 concepts UGC adaptés à un produit du catalogue ATM ci-dessus.

Pour chaque point commun :
- "commonPattern" : titre court du point commun
- "patternDescription" : description en 2-3 phrases
- "competitors" : au moins 2 marques distinctes (brand, market, adId, url) réellement présentes dans les données ci-dessus qui illustrent ce point commun

Pour chaque concept dans "concepts" :
- "product" : un produit du catalogue ATM ci-dessus (reprends le nom exact)
- "insightSource" : quels concurrents/adId ont inspiré ce concept précis (texte court, ex: "Gigamic (adId xyz), Big Potato (adId abc)")
- "concept" : description de la scène, du type de créateur UGC, de l'accroche visuelle
- "format" : POV, témoignage, unboxing, avant/après, réaction, ou autre format UGC pertinent
- "tagline" : un hook/tagline prêt à l'emploi, en français, inspiré du point commun mais original (jamais une copie du hook concurrent)

Règles :
1. N'invente aucune marque ni aucun adId : utilise uniquement ceux fournis dans les données.
2. Chaque point commun doit être étayé par au moins 2 concurrents différents.
3. Tout le texte en français.
4. N'utilise JAMAIS le tiret cadratin (—). Utilise une virgule, un deux-points ou des parenthèses à la place.
5. Génère entre 3 et 6 points communs au total.`;

  const response = await client.chat.completions.create({
    model: 'gpt-4.1',
    max_tokens: 12000,
    tools: [{
      type: 'function',
      function: {
      name: 'publish_ugc_ideas',
      description: 'Publie les points communs concurrents et les concepts UGC ATM Gaming associés',
      parameters: {
        type: 'object',
        required: ['ugcIdeas'],
        properties: {
          ugcIdeas: {
            type: 'array',
            items: {
              type: 'object',
              required: ['commonPattern', 'patternDescription', 'competitors', 'concepts'],
              properties: {
                commonPattern: { type: 'string' },
                patternDescription: { type: 'string' },
                competitors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['brand', 'market', 'adId', 'url'],
                    properties: {
                      brand: { type: 'string' }, market: { type: 'string' },
                      adId: { type: 'string' }, url: { type: 'string' },
                    },
                  },
                },
                concepts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['product', 'insightSource', 'concept', 'format', 'tagline'],
                    properties: {
                      product: { type: 'string', enum: ATM_CATALOG }, insightSource: { type: 'string' },
                      concept: { type: 'string' }, format: { type: 'string' }, tagline: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    }],
    tool_choice: { type: 'function', function: { name: 'publish_ugc_ideas' } },
    messages: [{ role: 'user', content: prompt }],
  });

  const choice = response.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('OpenAI a atteint la limite de tokens sur la génération des idées UGC.');
  }
  const toolCall = choice.message.tool_calls?.find(c => c.function?.name === 'publish_ugc_ideas');
  if (toolCall) {
    const parsed = JSON.parse(toolCall.function.arguments);
    if (parsed.ugcIdeas) return sanitizeDeep(parsed.ugcIdeas);
  }

  let text = (choice.message.content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return sanitizeDeep(JSON.parse(text).ugcIdeas || []);
}

// ─── Assemblage JSON final ──────────────────────────────────────────────────────

function buildTaglinesCompetitors(benchmark) {
  return MARKETS.flatMap(market =>
    benchmark[market].topPerformers
      .filter(ad => (ad.hook_text || '').trim())
      .map(ad => ({ brand: ad.brand, market, hook: ad.hook_text, url: ad.url })));
}

function buildTaglinesUGC(ugcIdeas) {
  return ugcIdeas.flatMap(idea =>
    idea.concepts.map(c => ({ product: c.product, tagline: c.tagline, sourcePattern: idea.commonPattern })));
}

function weekLabel() {
  const today = new Date();
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - 6);
  const fmt = d => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  return `${fmt(weekStart)} – ${fmt(today)} ${today.getFullYear()}`;
}

// ─── Génération HTML dark-mode (même style visuel que run-report.mjs) ──────────

function generateHTML(data) {
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const marketMeta = {
    fr: { flag: '🇫🇷', name: 'France', accent: '#3b82f6' },
    dach: { flag: '🇩🇪', name: 'DACH', accent: '#ef4444' },
    uk: { flag: '🇬🇧', name: 'UK', accent: '#f97316' },
    us: { flag: '🇺🇸', name: 'US/EN', accent: '#10b981' },
    it: { flag: '🇮🇹', name: 'Italie', accent: '#f59e0b' },
    es: { flag: '🇪🇸', name: 'Espagne', accent: '#ec4899' },
    nl: { flag: '🇳🇱', name: 'Pays-Bas', accent: '#06b6d4' },
    global: { flag: '🌍', name: 'Global', accent: '#8b5cf6' },
  };

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ATM Gaming : Benchmark UGC · ${data.weekLabel}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f1117;--surface:#1a1d29;--surface2:#252836;--surface3:#2e3347;--text:#e8eaf0;--muted:#9398a5;--border:#2e3347}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:inherit;text-decoration:none}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:36px;height:36px;background:#f59e0b;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px}
.logo-text{font-size:15px;font-weight:700}.logo-sub{font-size:11px;color:var(--muted);margin-top:1px}
.header-right{display:flex;align-items:center;gap:12px}
.date-badge{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:11px;color:var(--muted)}
.market-tabs{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.market-tabs::-webkit-scrollbar{display:none}
.mtab{padding:13px 18px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap;transition:.2s;user-select:none}
.mtab:hover{color:var(--text)}.mtab.active{color:var(--text);font-weight:600;border-bottom-color:var(--c-accent)}
.sub-tabs{padding:16px 24px 0;display:flex;gap:4px;flex-wrap:wrap}
.stab{padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:.2s;user-select:none}
.stab:hover{color:var(--text)}.stab.active{background:var(--surface2);color:var(--text)}
.content{padding:24px;max-width:1400px;margin:0 auto}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.section-head h2{font-size:15px;font-weight:700}
.section-count{background:var(--surface2);border-radius:20px;padding:2px 10px;font-size:11px;color:var(--muted)}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;position:relative;overflow:hidden}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--c-accent,#3b82f6)}
.kpi-value{font-size:26px;font-weight:800;color:var(--text);margin-bottom:3px}.kpi-label{font-size:11px;color:var(--muted);font-weight:500}
.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:22px}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px}
.chart-title{font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px}
.chart-desc{font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:14px}
.chart-wrap{height:190px;position:relative}
.brand-block{margin-bottom:18px}
.brand-block-title{font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text)}
.ads-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:20px}
.ad-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;transition:.2s}
.ad-card:hover{border-color:var(--c-accent)}
.ad-card.top{border-color:var(--c-accent)}
.ad-brand{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.ad-hook{font-size:13px;color:var(--text);line-height:1.5;margin-bottom:8px}
.ad-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ad-fmt{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:var(--surface2);color:var(--muted)}
.ad-days{font-size:11px;color:var(--muted)}
.ad-live{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700}
.ad-live.on{background:#16a34a22;color:#4ade80}
.ad-live.off{background:#6b728022;color:#9ca3af}
.ad-link{font-size:11px;color:var(--c-accent,#3b82f6);margin-left:auto}
.trends-list{display:flex;flex-direction:column;gap:12px;margin-bottom:20px}
.trend-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px}
.trend-title{font-size:14px;font-weight:600;margin-bottom:6px}
.trend-meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.trend-chip{padding:2px 9px;border-radius:20px;font-size:10px;font-weight:600;background:var(--surface2);color:var(--muted)}
.trend-desc{font-size:12px;color:var(--muted);line-height:1.55;margin-bottom:8px}
.trend-evidence{font-size:11px;color:var(--c-accent,#3b82f6);font-style:italic}
.ugc-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:16px}
.ugc-pattern{font-size:15px;font-weight:700;margin-bottom:6px;color:#f59e0b}
.ugc-desc{font-size:12px;color:var(--muted);line-height:1.55;margin-bottom:6px}
.ugc-evidence{font-size:11px;color:var(--muted);margin-bottom:14px}
.concept-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.concept-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px}
.concept-product{font-size:12px;font-weight:700;color:#f59e0b;margin-bottom:4px}
.concept-format{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:var(--surface3);color:var(--text);margin-bottom:8px}
.concept-text{font-size:12px;color:var(--text);line-height:1.5;margin-bottom:8px}
.concept-insight{font-size:10px;color:var(--muted);font-style:italic;margin-bottom:8px}
.concept-tagline{font-size:13px;font-weight:600;color:var(--text);background:var(--surface);border-left:3px solid #f59e0b;border-radius:0 8px 8px 0;padding:8px 12px}
.tagline-list{display:flex;flex-direction:column;gap:6px;margin-bottom:24px}
.tagline-row{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px}
.tagline-text{flex:1;font-size:13px;color:var(--text)}
.tagline-source{font-size:11px;color:var(--muted);white-space:nowrap}
.copy-btn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap}
.copy-btn:hover{color:var(--text)}
.empty{font-size:12px;color:var(--muted);padding:20px;text-align:center}
@media(max-width:600px){.content{padding:14px}.ads-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">🎯</div>
    <div>
      <div class="logo-text">ATM Gaming · Benchmark UGC</div>
      <div class="logo-sub">Semaine du ${data.weekLabel}</div>
    </div>
  </div>
  <div class="header-right"><div class="date-badge">📅 ${date}</div></div>
</div>

<div class="market-tabs" id="marketTabs"></div>
<div class="sub-tabs" id="subTabs">
  <button class="stab active" onclick="switchSubTab('resume')">📊 Résumé</button>
  <button class="stab" onclick="switchSubTab('benchmark')">📋 Pubs concurrentes</button>
  <button class="stab" onclick="switchSubTab('tendances')">📈 Tendances</button>
</div>
<div class="content" id="mainContent"></div>

<script>
const DATA = ${JSON.stringify(data)};
const MARKET_META = ${JSON.stringify(marketMeta)};
const MARKETS = ${JSON.stringify(MARKETS)};

let currentMarket = 'fr';
let currentSubTab = 'resume';
let currentTopTab = 'markets'; // markets | ugc | taglines
const SUB_TABS = ['resume', 'benchmark', 'tendances'];
const charts = {};

function accentOf(m) { return MARKET_META[m]?.accent || '#3b82f6'; }

function destroyCharts() {
  Object.values(charts).forEach(c => c && c.destroy());
  Object.keys(charts).forEach(k => delete charts[k]);
}

function renderTabs() {
  const marketTabsHtml = MARKETS.map(m => {
    const meta = MARKET_META[m];
    const count = (DATA.benchmark[m]?.brands || []).reduce((n, b) => n + b.ads.length, 0);
    return \`<div class="mtab \${currentTopTab==='markets'&&m===currentMarket?'active':''}" onclick="switchMarket('\${m}')">\${meta.flag} \${meta.name} <span style="opacity:.5;font-size:11px">\${count} pubs</span></div>\`;
  }).join('') +
    \`<div class="mtab \${currentTopTab==='ugc'?'active':''}" onclick="switchTopTab('ugc')">💡 Idées UGC <span style="opacity:.5;font-size:11px">\${DATA.ugcIdeas.length}</span></div>\` +
    \`<div class="mtab \${currentTopTab==='taglines'?'active':''}" onclick="switchTopTab('taglines')">🏷️ Taglines</div>\`;
  document.getElementById('marketTabs').innerHTML = marketTabsHtml;
  document.querySelectorAll('.mtab').forEach(t => t.style.setProperty('--c-accent', currentTopTab==='markets' ? accentOf(currentMarket) : '#f59e0b'));
}

function switchMarket(m) {
  currentMarket = m; currentTopTab = 'markets'; currentSubTab = 'resume';
  document.getElementById('subTabs').style.display = 'flex';
  document.querySelectorAll('.stab').forEach((t,i) => t.classList.toggle('active', SUB_TABS[i]==='resume'));
  destroyCharts();
  renderTabs(); render();
}

function switchTopTab(tab) {
  currentTopTab = tab;
  document.getElementById('subTabs').style.display = 'none';
  destroyCharts();
  renderTabs(); render();
}

function switchSubTab(tab) {
  currentSubTab = tab;
  document.querySelectorAll('.stab').forEach((t,i) => t.classList.toggle('active', SUB_TABS[i]===tab));
  destroyCharts();
  render();
}

function render() {
  const mc = document.getElementById('mainContent');
  mc.style.setProperty('--c-accent', currentTopTab==='markets' ? accentOf(currentMarket) : '#f59e0b');
  if (currentTopTab === 'ugc') { mc.innerHTML = renderUGC(); return; }
  if (currentTopTab === 'taglines') { mc.innerHTML = renderTaglines(); return; }
  const D = DATA.benchmark[currentMarket] || { brands: [], topPerformers: [] };
  if (currentSubTab === 'resume') { mc.innerHTML = renderResume(D); initCharts(D); return; }
  mc.innerHTML = currentSubTab === 'benchmark' ? renderBenchmark() : renderTrends();
}

function renderResume(D) {
  const brands = D.brands || [];
  const topPerformers = D.topPerformers || [];
  const adsCount = brands.reduce((n, b) => n + b.ads.length, 0);
  const liveCount = brands.reduce((n, b) => n + b.ads.filter(a => a.live === true).length, 0);
  const kpis = [
    { val: adsCount, label: 'Pubs détectées' },
    { val: brands.length, label: 'Marques suivies' },
    { val: liveCount, label: 'Pubs live' },
    { val: topPerformers.length, label: 'Top performers' },
  ];
  const kpiHtml = kpis.map(k => \`<div class="kpi-card"><div class="kpi-value">\${k.val}</div><div class="kpi-label">\${k.label}</div></div>\`).join('');
  if (!brands.length) {
    return \`<div class="section-head"><h2>Résumé \${MARKET_META[currentMarket].flag} \${MARKET_META[currentMarket].name}</h2></div><div class="kpi-grid">\${kpiHtml}</div><div class="empty">Aucune pub concurrente détectée sur ce marché cette semaine.</div>\`;
  }
  return \`
    <div class="section-head"><h2>Résumé \${MARKET_META[currentMarket].flag} \${MARKET_META[currentMarket].name}</h2></div>
    <div class="kpi-grid">\${kpiHtml}</div>
    <div class="charts-grid">
      <div class="chart-card">
        <div class="chart-title">Roue de performance : formats des top performers</div>
        <div class="chart-desc">Répartition par format (VIDEO, IMAGE, CAROUSEL...) des pubs qui durent le plus longtemps et/ou sont encore live sur ce marché. Le format le plus représenté est celui que vos concurrents ont validé par la performance : c'est un signal à prioriser dans vos propres tests créatifs.</div>
        <div class="chart-wrap"><canvas id="cFormats"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Activité des top performers par marque</div>
        <div class="chart-desc">Nombre de pubs de chaque marque présentes dans le top performers du marché (parmi les 8 meilleures). Une marque avec plusieurs barres concentre ses efforts créatifs sur des publicités qui durent, signe d'un système publicitaire éprouvé à surveiller de près.</div>
        <div class="chart-wrap"><canvas id="cBrands"></canvas></div>
      </div>
    </div>\`;
}

function initCharts(D) {
  const topPerformers = D.topPerformers || [];
  if (!topPerformers.length) return;
  const accent = accentOf(currentMarket);
  const gray = 'rgba(255,255,255,0.1)';
  const fmts = {}, brandCounts = {};
  topPerformers.forEach(ad => {
    fmts[ad.format || 'Inconnu'] = (fmts[ad.format || 'Inconnu']||0)+1;
    brandCounts[ad.brand] = (brandCounts[ad.brand]||0)+1;
  });
  const pal = [accent,'#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4'];
  const fc = document.getElementById('cFormats');
  if (fc) {
    charts.formats = new Chart(fc, {
      type: 'doughnut',
      data: { labels: Object.keys(fmts), datasets: [{ data: Object.values(fmts), backgroundColor: pal, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#9398a5', font: { size: 10 } } } } }
    });
  }
  const bc = document.getElementById('cBrands');
  if (bc) {
    const bArr = Object.entries(brandCounts).sort((a,b) => b[1]-a[1]);
    charts.brands = new Chart(bc, {
      type: 'bar',
      data: { labels: bArr.map(e => e[0].split(' ')[0]), datasets: [{ data: bArr.map(e => e[1]), backgroundColor: accent+'aa', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#9398a5', font: { size: 9 } }, grid: { color: gray } }, y: { ticks: { color: '#9398a5', font: { size: 9 } }, grid: { color: gray } } } }
    });
  }
}

function adCard(ad, isTop) {
  const live = ad.live === true ? '<span class="ad-live on">● Live</span>' : ad.live === false ? '<span class="ad-live off">Terminée</span>' : '';
  return \`
    <div class="ad-card \${isTop?'top':''}">
      <div class="ad-brand">\${ad.brand}\${isTop?' · 🏆 top performer':''}</div>
      <div class="ad-hook">\${(ad.hook_text||'(hook non renseigné)').replace(/\\n/g,' ')}</div>
      <div class="ad-footer">
        <span class="ad-fmt">\${ad.format||''}</span>
        <span class="ad-days">⏱ \${ad.days_active||0}j</span>
        \${live}
        <a class="ad-link" href="\${ad.url}" target="_blank">Voir sur Foreplay →</a>
      </div>
    </div>\`;
}

function renderBenchmark() {
  const D = DATA.benchmark[currentMarket] || { brands: [], topPerformers: [] };
  const topIds = new Set((D.topPerformers||[]).map(a=>a.id));
  if (!D.brands.length) return '<div class="empty">Aucune pub concurrente détectée sur ce marché cette semaine.</div>';
  const blocks = D.brands.map(b => \`
    <div class="brand-block">
      <div class="brand-block-title">\${b.name} <span style="color:var(--muted);font-weight:400">· \${b.ads.length} pubs</span></div>
      <div class="ads-grid">\${b.ads.map(ad => adCard({...ad, brand: b.name}, topIds.has(ad.id))).join('')}</div>
    </div>\`).join('');
  return \`<div class="section-head"><h2>Pubs concurrentes \${MARKET_META[currentMarket].flag} \${MARKET_META[currentMarket].name}</h2><span class="section-count">\${D.brands.length} marques</span></div>\${blocks}\`;
}

function renderTrends() {
  const trends = DATA.trends[currentMarket] || [];
  if (!trends.length) return '<div class="empty">Aucune tendance détectée sur ce marché cette semaine.</div>';
  const html = trends.map(t => \`
    <div class="trend-card">
      <div class="trend-title">\${t.title}</div>
      <div class="trend-meta">
        <span class="trend-chip">🎯 \${t.angle}</span>
        <span class="trend-chip">🎬 \${t.dominantFormat}</span>
        <span class="trend-chip">🪝 \${t.hookStructure}</span>
        <span class="trend-chip">🏷️ \${t.theme}</span>
      </div>
      <div class="trend-desc">\${t.description}</div>
      <div class="trend-evidence">📎 \${(t.evidence||[]).map(e=>\`<a href="\${e.url}" target="_blank" style="color:inherit">\${e.brand} (\${e.adId})</a>\`).join(', ')}</div>
    </div>\`).join('');
  return \`<div class="section-head"><h2>Tendances \${MARKET_META[currentMarket].flag} \${MARKET_META[currentMarket].name}</h2><span class="section-count">\${trends.length} tendances</span></div><div class="trends-list">\${html}</div>\`;
}

function renderUGC() {
  if (!DATA.ugcIdeas.length) return '<div class="empty">Aucune idée UGC générée.</div>';
  const html = DATA.ugcIdeas.map(idea => \`
    <div class="ugc-card">
      <div class="ugc-pattern">\${idea.commonPattern}</div>
      <div class="ugc-desc">\${idea.patternDescription}</div>
      <div class="ugc-evidence">📎 Observé chez : \${(idea.competitors||[]).map(c=>\`<a href="\${c.url}" target="_blank" style="color:var(--c-accent)">\${c.brand} (\${c.market})</a>\`).join(', ')}</div>
      <div class="concept-grid">
        \${(idea.concepts||[]).map(c => \`
          <div class="concept-card">
            <div class="concept-product">\${c.product}</div>
            <div class="concept-format">\${c.format}</div>
            <div class="concept-text">\${c.concept}</div>
            <div class="concept-insight">💡 Inspiré de : \${c.insightSource}</div>
            <div class="concept-tagline">"\${c.tagline}"</div>
          </div>\`).join('')}
      </div>
    </div>\`).join('');
  return \`<div class="section-head"><h2>💡 Idées UGC, tous marchés</h2><span class="section-count">\${DATA.ugcIdeas.length} points communs</span></div>\${html}\`;
}

function copyText(el, text) {
  navigator.clipboard?.writeText(text).then(() => {
    const old = el.textContent; el.textContent = 'Copié !';
    setTimeout(() => { el.textContent = old; }, 1200);
  }).catch(() => {});
}

function renderTaglines() {
  const compRows = DATA.taglinesCompetitors.map((t,i) => \`
    <div class="tagline-row">
      <div class="tagline-text">"\${t.hook}"</div>
      <div class="tagline-source">\${t.brand} · \${MARKET_META[t.market]?.flag||''} \${MARKET_META[t.market]?.name||t.market}</div>
      <button class="copy-btn" onclick="copyText(this, \${JSON.stringify(t.hook)})">Copier</button>
    </div>\`).join('');
  const ugcRows = DATA.taglinesUGC.map((t,i) => \`
    <div class="tagline-row">
      <div class="tagline-text">"\${t.tagline}"</div>
      <div class="tagline-source">\${t.product}</div>
      <button class="copy-btn" onclick="copyText(this, \${JSON.stringify(t.tagline)})">Copier</button>
    </div>\`).join('');
  return \`
    <div class="section-head"><h2>🏷️ Taglines concurrents</h2><span class="section-count">\${DATA.taglinesCompetitors.length}</span></div>
    <div class="tagline-list">\${compRows || '<div class="empty">Aucun tagline concurrent.</div>'}</div>
    <div class="section-head"><h2>🏷️ Taglines UGC ATM Gaming</h2><span class="section-count">\${DATA.taglinesUGC.length}</span></div>
    <div class="tagline-list">\${ugcRows || '<div class="empty">Aucun tagline UGC généré.</div>'}</div>\`;
}

renderTabs();
render();
</script>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 ATM Gaming — Benchmark pubs concurrentes + idées UGC\n');

  const ads = await fetchBenchmarkData();
  if (ads.length === 0) throw new Error('Aucune donnée récupérée. Vérifie ta clé API Foreplay.');

  // Garde-fous de qualité (spec §9) : on interrompt le run avant toute écriture de
  // fichier plutôt que de publier un dataset silencieusement dégradé.
  const nullRate = nullLongevityRate(ads);
  const hookRate = emptyHookRate(ads);
  if (nullRate > 0.2) {
    throw new Error(`Garde-fou qualité : ${(nullRate * 100).toFixed(0)}% des pubs ont running_days = 0 (seuil 20%). Run interrompu, ne pas publier.`);
  }
  if (hookRate > 0.3) {
    throw new Error(`Garde-fou qualité : ${(hookRate * 100).toFixed(0)}% des pubs ont un hook vide (seuil 30%). Run interrompu, ne pas publier.`);
  }

  const today = new Date().toISOString().split('T')[0];

  if (!existsSync('data')) mkdirSync('data', { recursive: true });
  writeFileSync(`data/dataset-${today}.json`, JSON.stringify({ generatedAt: today, ads }, null, 2), 'utf8');
  console.log(`  → Dataset canonique sauvegardé : data/dataset-${today}.json (${ads.length} pubs, ${(nullRate * 100).toFixed(1)}% longévités nulles, ${(hookRate * 100).toFixed(1)}% hooks vides)`);

  const benchmark = buildBenchmarkView(ads);
  const totalAds = MARKETS.reduce((n, m) => n + (benchmark[m]?.brands || []).reduce((s, b) => s + b.ads.length, 0), 0);
  const maskedCount = ads.length - totalAds;
  console.log(`  → ${totalAds} pubs concurrentes en périmètre pour le dashboard (${maskedCount} pubs hors périmètre ou marque ATM masquées de la vue "Pubs concurrentes")`);
  if (totalAds === 0) throw new Error('Aucune donnée concurrente en périmètre pour le dashboard. Vérifie la classification in_scope/owner.');

  const client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 300000 });
  const [trends, ugcIdeas] = await Promise.all([
    analyzeTrends(client, benchmark),
    analyzeUGC(client, benchmark),
  ]);

  const data = {
    generatedAt: today,
    weekLabel: weekLabel(),
    benchmark,
    trends,
    ugcIdeas,
    taglinesCompetitors: buildTaglinesCompetitors(benchmark),
    taglinesUGC: buildTaglinesUGC(ugcIdeas),
  };

  const jsonFilename = `data/benchmark-ugc-${today}.json`;
  writeFileSync(jsonFilename, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  → JSON sauvegardé : ${jsonFilename}`);

  if (!existsSync('docs')) mkdirSync('docs', { recursive: true });
  const htmlFilename = `docs/benchmark-ugc-${today}.html`;
  writeFileSync(htmlFilename, generateHTML(data), 'utf8');
  console.log(`  → HTML sauvegardé : ${htmlFilename}`);

  console.log(`\n✅ Terminé : ${totalAds} pubs concurrentes · ${data.ugcIdeas.length} points communs UGC · ${data.taglinesUGC.length} taglines UGC générés`);
}

main().catch(err => {
  console.error('❌ Erreur fatale:', err.message);
  process.exit(1);
});
