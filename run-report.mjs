// ATM Gaming — Rapport de veille concurrence hebdomadaire v2
// Dashboard multi-pays avec section Mes Perfs ATM

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const FOREPLAY_API_KEY   = process.env.FOREPLAY_API_KEY;
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID   = 'C0BDJS75E04'; // #veille-concu-fr
const FOREPLAY_BASE      = 'https://public.api.foreplay.co';
const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // ex: "123456789" ou "act_123456789"

// GitHub Pages — format : "username/repo-name" injecté automatiquement par GitHub Actions
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || '';
const GITHUB_PAGES_BASE = GITHUB_REPO
  ? `https://${GITHUB_REPO.split('/')[0]}.github.io/${GITHUB_REPO.split('/')[1]}`
  : '';

// Marques ATM Gaming — séparées des concurrents pour la section "Mes Perfs"
const OWN_BRAND_KEYWORDS = ['quickstop', 'pili pili', 'speedbac', 'smash it', 'jumo',
  'play hit', 'mouton mouton', 'little secret', 'ranking', 'atm gaming'];

// Marques hors industrie à ignorer dans l'analyse (dating, food, beauty...)
const IRRELEVANT_KEYWORDS = ['meetic', 'tinder', 'paired', 'fruitz', 'air up', 'poppi',
  'holy energy', 'naali', 'my lubie', 'melba', 'io sono te'];

// Classification pays par nom de marque
const COUNTRY_RULES = [
  { country: 'fr',     keywords: ['gigamic', 'bakakou', 'traitres', 'savana', 'olé mains', 'ole mains', 'cranio'] },
  { country: 'dach',   keywords: ['yaqua', 'crack games', 'crack list', 'holy ', 'weplay'] },
  { country: 'uk',     keywords: ['big potato', 'bigpotato'] },
  { country: 'us',     keywords: ['wdym', 'what do you meme', 'hitster', 'kollide', 'poppi'] },
  { country: 'global', keywords: ['lego', 'mattel', 'uno', 'hasbro', 'asmodee', 'ravensburger', 'ghenos', 'naali', 'air up'] },
];

function classifyCountry(brandName) {
  const n = (brandName || '').toLowerCase();
  for (const { country, keywords } of COUNTRY_RULES) {
    if (keywords.some(kw => n.includes(kw))) return country;
  }
  return 'global';
}

function isOwnBrand(name) {
  const n = (name || '').toLowerCase();
  return OWN_BRAND_KEYWORDS.some(kw => n.includes(kw));
}

function isIrrelevant(name) {
  const n = (name || '').toLowerCase();
  return IRRELEVANT_KEYWORDS.some(kw => n.includes(kw));
}

// ─── Foreplay API ──────────────────────────────────────────────────────────────

async function foreplayGet(path, params = {}) {
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

async function getSpyderBrands() {
  const pages = await Promise.all([
    foreplayGet('/api/spyder/brands', { limit: 10, offset: 0 }),
    foreplayGet('/api/spyder/brands', { limit: 10, offset: 10 }),
    foreplayGet('/api/spyder/brands', { limit: 10, offset: 20 }),
  ]);
  return pages.flatMap(p => p.brands || p.data || p || []);
}

async function getBrandAds(brandId) {
  const resp = await foreplayGet('/api/spyder/brand/ads', { brand_id: brandId, limit: 20, order: 'newest' });
  return (resp.ads || resp.data || resp || []).map(ad => ({
    id: ad.id,
    format: ad.format || ad.ad_type || ad.type || 'Inconnu',
    platforms: ad.platforms || [],
    days_active: ad.days_active || ad.daysActive || 0,
    start_date: ad.start_date || ad.startDate || null,
    hook_text: ad.hook_text || ad.hookText || ad.caption || ad.text || ad.description || '',
    img: ad.image_url || ad.imageUrl || ad.thumbnail_url || ad.thumbnailUrl || '',
    url: ad.foreplay_url || `https://app.foreplay.co/discovery?ad=${ad.id}`,
  }));
}

async function fetchAllData() {
  console.log('📡 Récupération des marques Foreplay Spyder...');
  const [allBrands, meta] = await Promise.all([getSpyderBrands(), fetchMetaData()]);
  console.log(`  → ${allBrands.length} marques trouvées`);

  const competitorBrands = allBrands.filter(b => !isOwnBrand(b.name) && !isIrrelevant(b.name));
  const ownBrands        = allBrands.filter(b =>  isOwnBrand(b.name));

  console.log(`  → ${competitorBrands.length} concurrents · ${ownBrands.length} marques ATM`);

  const [competitorResults, ownResults] = await Promise.all([
    Promise.allSettled(competitorBrands.map(async b => {
      const ads = await getBrandAds(b.id);
      return { brand: { id: b.id, name: b.name, country: classifyCountry(b.name) }, ads };
    })),
    Promise.allSettled(ownBrands.map(async b => {
      const ads = await getBrandAds(b.id);
      return { brand: { id: b.id, name: b.name }, ads };
    }))
  ]);

  return {
    meta,
    competitors: competitorResults
      .filter(r => r.status === 'fulfilled' && r.value.ads.length > 0)
      .map(r => r.value),
    ownBrands: ownResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
  };
}

// ─── Meta Ads API ──────────────────────────────────────────────────────────────

async function fetchMetaData() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.log('ℹ️  META_ACCESS_TOKEN / META_AD_ACCOUNT_ID non configurés — section ATM sans données Meta');
    return null;
  }

  const accountId = META_AD_ACCOUNT_ID.startsWith('act_') ? META_AD_ACCOUNT_ID : `act_${META_AD_ACCOUNT_ID}`;
  const today = new Date();
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
  const since = weekAgo.toISOString().split('T')[0];
  const until = today.toISOString().split('T')[0];

  const metaGet = async (path, params = {}) => {
    const url = new URL(`https://graph.facebook.com/v21.0${path}`);
    url.searchParams.set('access_token', META_ACCESS_TOKEN);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) { const b = await res.text(); throw new Error(`Meta ${res.status}: ${b}`); }
    return res.json();
  };

  try {
    console.log('📱 Récupération données Meta Ads...');

    const [insightsResp, campaignsResp] = await Promise.all([
      metaGet(`/${accountId}/insights`, {
        fields: 'spend,impressions,clicks,actions,cost_per_action_type,purchase_roas,action_values',
        time_range: JSON.stringify({ since, until }),
        level: 'account'
      }),
      metaGet(`/${accountId}/campaigns`, {
        fields: `name,status,insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,clicks,actions,purchase_roas}`,
        limit: 20
      })
    ]);

    const ins = insightsResp.data?.[0] || {};
    const totalSpend   = parseFloat(ins.spend || 0);
    const impressions  = parseInt(ins.impressions || 0);
    const clicks       = parseInt(ins.clicks || 0);
    const purchases    = parseInt(ins.actions?.find(a => a.action_type === 'purchase')?.value || 0);
    const roas         = parseFloat(ins.purchase_roas?.[0]?.value || 0);
    const cpa          = purchases > 0 ? parseFloat((totalSpend / purchases).toFixed(2)) : null;
    const ctr          = impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0;

    const campaigns = (campaignsResp.data || [])
      .filter(c => c.insights?.data?.[0]?.spend > 0)
      .map(c => {
        const ci = c.insights.data[0];
        const cpurchases = parseInt(ci.actions?.find(a => a.action_type === 'purchase')?.value || 0);
        return {
          name: c.name,
          status: c.status,
          spend: parseFloat(ci.spend || 0),
          impressions: parseInt(ci.impressions || 0),
          clicks: parseInt(ci.clicks || 0),
          roas: parseFloat(ci.purchase_roas?.[0]?.value || 0),
          purchases: cpurchases,
          cpa: cpurchases > 0 ? parseFloat((parseFloat(ci.spend) / cpurchases).toFixed(2)) : null
        };
      })
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);

    console.log(`  → Meta: ${totalSpend.toFixed(0)}€ · ROAS ${roas.toFixed(1)}x · CPA ${cpa ?? 'N/A'}€ · ${purchases} achats`);
    return { spend: totalSpend, impressions, clicks, purchases, roas, cpa, ctr, campaigns, period: { since, until } };

  } catch (err) {
    console.warn(`⚠️  Meta API erreur (non bloquant): ${err.message}`);
    return null;
  }
}

// ─── Analyse Claude ────────────────────────────────────────────────────────────

async function analyzeWithClaude(data) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const today = new Date();
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - 6);
  const fmt = d => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const weekLabel = `${fmt(weekStart)} – ${fmt(today)} ${today.getFullYear()}`;

  const totalAds = data.competitors.reduce((n, b) => n + b.ads.length, 0);
  const totalOwn = data.ownBrands.reduce((n, b) => n + b.ads.length, 0);
  console.log(`🤖 Envoi de ${totalAds} pubs concurrentes + ${totalOwn} pubs ATM à Claude...`);

  const prompt = `Tu es expert en veille publicitaire pour ATM Gaming (jeux de société FR : Speedbac, Pili Pili, Smash It, JUMO, Quickstop Family, Play Hit, Mouton Mouton, Little Secret, Ranking).

Voici les pubs concurrentes — INDUSTRIE JEUX DE SOCIÉTÉ / ENTERTAINMENT uniquement — semaine du ${weekLabel} :

CONCURRENTS PAR PAYS (déjà pré-classifiés) :
${JSON.stringify(data.competitors, null, 2)}

MARQUES ATM GAMING (pour la section "Mes Perfs") :
${JSON.stringify(data.ownBrands, null, 2)}

DONNÉES META ADS ATM GAMING (semaine en cours) :
${data.meta ? JSON.stringify(data.meta, null, 2) : 'Non disponible (META_ACCESS_TOKEN non configuré)'}

Retourne UNIQUEMENT un objet JSON valide (sans markdown, sans \`\`\`, sans texte avant ou après) avec cette structure exacte :

{
  "weekLabel": "${weekLabel}",
  "totalAds": <nombre total pubs concurrentes>,
  "activeBrands": <nombre marques concurrentes actives>,
  "globalInsights": [
    "<emoji> <insight global clé 1 — chiffré>",
    "<emoji> <insight global clé 2>",
    "<emoji> <insight global clé 3>",
    "<emoji> <insight global clé 4>",
    "<emoji> <insight global clé 5>"
  ],
  "countries": {
    "fr": {
      "adsCount": <nombre>,
      "liveCount": <nombre live>,
      "brands": [
        {
          "name": "<nom marque>",
          "adsCount": <nombre>,
          "liveCount": <nombre live>,
          "formats": "<ex: VIDEO×3, IMAGE×4, DCO×2>",
          "topAngle": "<angle créatif dominant en 3-5 mots>",
          "tags": ["live", "hot", "nouveau"]
        }
      ],
      "topAds": [
        {
          "id": "<foreplay id>",
          "brand": "<nom marque>",
          "format": "VIDEO|IMAGE|CAROUSEL|DCO",
          "days": <jours actif>,
          "hook": "<texte du hook / caption, max 120 car.>",
          "angle": "<angle marketing en 4-6 mots>",
          "img": "<url image ou thumbnail>",
          "url": "<foreplay url>",
          "live": true
        }
      ],
      "trends": [
        {
          "icon": "<emoji>",
          "title": "<titre de la tendance>",
          "desc": "<description en 2-3 phrases, chiffrée si possible>",
          "evidence": "<sources concrètes: ad IDs, copies, URLs>"
        }
      ],
      "creativeTests": [
        {
          "title": "<marque — description du test A/B>",
          "hook": "<description de ce que le test mesure>",
          "count": <nombre de variantes>,
          "brand": "<nom marque>"
        }
      ],
      "recommendation": {
        "product": "<produit ATM Gaming>",
        "format": "<format>",
        "hook": "<suggestion de hook concrète inspirée des concurrents>",
        "inspiration": "<marque source>",
        "priority": "Haute|Moyenne|Basse"
      }
    },
    "dach": { ... <même structure que fr> ... },
    "uk": { ... <même structure que fr> ... },
    "us": { ... <même structure que fr> ... },
    "global": { ... <même structure que fr> ... }
  },
  "atm": {
    "totalAds": <nombre>,
    "liveAds": <nombre live>,
    "brands": [
      {
        "name": "<nom marque ATM>",
        "adsCount": <nombre>,
        "liveCount": <nombre live>,
        "market": "<ex: 🇫🇷 France>",
        "formats": "<ex: IMAGE×5, DCO×12, VIDEO×2>",
        "topAngle": "<angle dominant>",
        "tags": ["live"]
      }
    ],
    "topAds": [
      {
        "id": "<foreplay id>",
        "brand": "<nom marque ATM>",
        "format": "<format>",
        "days": <jours actif>,
        "hook": "<texte hook>",
        "img": "<url>",
        "url": "<foreplay url>",
        "live": true
      }
    ],
    "insights": [
      {
        "icon": "<emoji>",
        "title": "<insight stratégique>",
        "desc": "<analyse en 2-3 phrases>",
        "evidence": "<sources>"
      }
    ]
  }
}

Règles IMPORTANTES :
1. Chaque pays dans "countries" doit avoir MINIMUM 3 creativeTests — si tu n'en vois que 1-2, crée des suggestions hypothétiques à tester basées sur les tendances observées, en le signalant dans le titre ("Suggestion A/B : ...")
2. topAds : maximum 6 pubs par pays, les plus récentes ou les plus longues en premier
3. trends : 3 à 4 tendances par pays, chiffrées avec exemples réels
4. recommendation : 1 recommandation actionnable par pays pour ATM Gaming
5. Ignore les marques hors jeux de société / entertainment (dating, food, beauté)
6. Tous les textes en français
7. Les URLs Foreplay : format https://app.foreplay.co/discovery?ad=<id>
8. Pour les pays sans données (ex: DACH si aucune marque DACH cette semaine), retourne un objet avec adsCount:0 et les autres champs en tableaux vides`;

  const countrySchema = {
    type: 'object',
    properties: {
      adsCount:  { type: 'integer' },
      liveCount: { type: 'integer' },
      brands: { type: 'array', items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, adsCount: { type: 'integer' }, liveCount: { type: 'integer' },
          formats: { type: 'string' }, topAngle: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }
        }, required: ['name', 'adsCount', 'liveCount']
      }},
      topAds: { type: 'array', items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, brand: { type: 'string' }, format: { type: 'string' },
          days: { type: 'integer' }, hook: { type: 'string' }, angle: { type: 'string' },
          img: { type: 'string' }, url: { type: 'string' }, live: { type: 'boolean' }
        }, required: ['id', 'brand', 'format', 'url']
      }},
      trends: { type: 'array', items: {
        type: 'object',
        properties: { icon: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, evidence: { type: 'string' } },
        required: ['icon', 'title', 'desc']
      }},
      creativeTests: { type: 'array', items: {
        type: 'object',
        properties: { title: { type: 'string' }, hook: { type: 'string' }, count: { type: 'integer' }, brand: { type: 'string' } },
        required: ['title', 'hook']
      }},
      recommendation: {
        type: 'object',
        properties: {
          product: { type: 'string' }, format: { type: 'string' }, hook: { type: 'string' },
          inspiration: { type: 'string' }, priority: { type: 'string', enum: ['Haute', 'Moyenne', 'Basse'] }
        }
      }
    },
    required: ['adsCount', 'liveCount', 'brands', 'topAds', 'trends', 'creativeTests', 'recommendation']
  };

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    tools: [{
      name: 'publish_veille',
      description: 'Publie l\'analyse de veille concurrence hebdomadaire structurée',
      input_schema: {
        type: 'object',
        required: ['weekLabel', 'totalAds', 'activeBrands', 'globalInsights', 'countries', 'atm'],
        properties: {
          weekLabel:     { type: 'string' },
          totalAds:      { type: 'integer' },
          activeBrands:  { type: 'integer' },
          globalInsights: { type: 'array', items: { type: 'string' } },
          countries: {
            type: 'object',
            properties: { fr: countrySchema, dach: countrySchema, uk: countrySchema, us: countrySchema, global: countrySchema },
            required: ['fr', 'dach', 'uk', 'us', 'global']
          },
          atm: {
            type: 'object',
            required: ['totalAds', 'liveAds', 'brands', 'topAds', 'insights'],
            properties: {
              totalAds:    { type: 'integer' },
              liveAds:     { type: 'integer' },
              spend:       { type: 'number', description: 'Dépenses Meta Ads cette semaine en euros' },
              roas:        { type: 'number', description: 'ROAS Meta Ads (retour sur dépenses pub)' },
              cpa:         { type: 'number', description: 'CPA moyen en euros (coût par achat)' },
              ctr:         { type: 'number', description: 'CTR moyen en %' },
              purchases:   { type: 'integer', description: 'Nombre total d\'achats attribués' },
              impressions: { type: 'integer', description: 'Nombre total d\'impressions' },
              topCampaigns: { type: 'array', items: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, spend: { type: 'number' },
                  roas: { type: 'number' }, cpa: { type: 'number' },
                  purchases: { type: 'integer' }, status: { type: 'string' }
                }, required: ['name', 'spend']
              }},
              brands: { type: 'array', items: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, adsCount: { type: 'integer' }, liveCount: { type: 'integer' },
                  market: { type: 'string' }, formats: { type: 'string' }, topAngle: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } }
                }, required: ['name', 'adsCount', 'liveCount']
              }},
              topAds: { type: 'array', items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, brand: { type: 'string' }, format: { type: 'string' },
                  days: { type: 'integer' }, hook: { type: 'string' }, img: { type: 'string' },
                  url: { type: 'string' }, live: { type: 'boolean' }
                }, required: ['id', 'brand', 'format', 'url']
              }},
              insights: { type: 'array', items: {
                type: 'object',
                properties: { icon: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, evidence: { type: 'string' } },
                required: ['icon', 'title', 'desc']
              }}
            }
          }
        }
      }
    }],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: prompt }]
  });

  // Extract structured output from tool use (guaranteed valid JSON)
  const toolUse = message.content.find(b => b.type === 'tool_use');
  if (toolUse) return toolUse.input;

  // Fallback: parse text response
  let text = (message.content[0]?.text || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text.startsWith('{')) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) text = match[0];
  }
  return JSON.parse(text);
}

// ─── Génération HTML multi-pays ────────────────────────────────────────────────

function generateHTML(a) {
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const countryMeta = {
    global: { flag: '🌍', name: 'Global',  accent: '#8b5cf6' },
    fr:     { flag: '🇫🇷', name: 'France',  accent: '#3b82f6' },
    dach:   { flag: '🇩🇪', name: 'DACH',    accent: '#ef4444' },
    uk:     { flag: '🇬🇧', name: 'UK',      accent: '#f97316' },
    us:     { flag: '🇺🇸', name: 'US/EN',   accent: '#10b981' },
  };

  const totalByCountry = Object.entries(a.countries)
    .map(([k, v]) => `${countryMeta[k]?.flag} ${countryMeta[k]?.name} <span style="opacity:.5;font-size:11px">${v.adsCount} pubs</span>`)
    .join('');

  const countryTabsHtml = Object.entries(a.countries)
    .map(([k, v]) => `<div class="ctab ${k==='global'?'active':''}" data-country="${k}" onclick="switchCountry('${k}')">${countryMeta[k]?.flag} ${countryMeta[k]?.name} <span style="opacity:.5;font-size:11px">${v.adsCount} pubs</span></div>`)
    .join('') + `<div class="ctab" data-country="atm" onclick="switchCountry('atm')">📊 Mes Perfs ATM <span style="opacity:.5;font-size:11px">${a.atm?.totalAds||0} pubs</span></div>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ATM Gaming — Dashboard Veille · ${a.weekLabel}</title>
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
.live-badge{background:#16a34a22;border:1px solid #16a34a55;color:#4ade80;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:600}
.country-tabs{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.country-tabs::-webkit-scrollbar{display:none}
.ctab{padding:13px 18px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap;transition:.2s;user-select:none}
.ctab:hover{color:var(--text)}.ctab.active{color:var(--text);font-weight:600;border-bottom-color:var(--c-accent)}
.sub-tabs{padding:16px 24px 0;display:flex;gap:4px;flex-wrap:wrap}
.stab{padding:7px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:.2s;user-select:none}
.stab:hover{color:var(--text)}.stab.active{background:var(--surface2);color:var(--text)}
.content{padding:24px;max-width:1400px;margin:0 auto}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;position:relative;overflow:hidden}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--c-accent,#3b82f6)}
.kpi-value{font-size:26px;font-weight:800;color:var(--text);margin-bottom:3px}.kpi-label{font-size:11px;color:var(--muted);font-weight:500}
.kpi-delta{margin-top:7px;font-size:11px;font-weight:600}.kpi-delta.up{color:#4ade80}.kpi-delta.neutral{color:var(--muted)}
.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:22px}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px}
.chart-title{font-size:12px;font-weight:600;color:var(--text);margin-bottom:14px}
.chart-wrap{height:170px;position:relative}
.brands-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px;margin-bottom:22px}
.brand-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;gap:10px}
.brand-name{font-size:13px;font-weight:600;margin-bottom:2px}.brand-meta{font-size:11px;color:var(--muted);margin-bottom:6px}
.brand-tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:var(--surface2)}
.tag.live{background:#16a34a22;color:#4ade80}.tag.hot{background:#ef444422;color:#f87171}.tag.nouveau{background:#3b82f622;color:#60a5fa}
.ads-controls{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.filter-btn{padding:5px 11px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:.2s}
.filter-btn.active,.filter-btn:hover{background:var(--surface2);color:var(--text)}
.ads-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.ad-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:pointer;transition:.2s}
.ad-card:hover{border-color:var(--c-accent);transform:translateY(-2px)}
.ad-thumb{width:100%;height:150px;background:var(--surface2);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.ad-thumb img{width:100%;height:100%;object-fit:cover}
.vplay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0006}
.vplay-icon{width:38px;height:38px;background:#fff3;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px}
.ad-body{padding:11px}.ad-brand{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.ad-desc{font-size:12px;color:var(--text);line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:7px}
.ad-footer{display:flex;align-items:center;gap:6px}
.ad-fmt{padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;background:var(--surface2);color:var(--muted)}
.ad-days{font-size:10px;color:var(--muted)}.ad-live{width:5px;height:5px;border-radius:50%;background:#4ade80;flex-shrink:0}
.ad-link{font-size:10px;color:var(--c-accent,#3b82f6);margin-top:5px;display:block}
.top-list{display:flex;flex-direction:column;gap:12px}
.top-item{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;gap:12px}
.top-rank{font-size:22px;font-weight:800;color:var(--c-accent);min-width:32px;text-align:center}
.top-img{width:72px;height:54px;border-radius:8px;object-fit:cover;background:var(--surface2);flex-shrink:0}
.top-body{flex:1}.top-brand{font-size:11px;font-weight:600;color:var(--muted);margin-bottom:3px}
.top-hook{font-size:13px;color:var(--text);line-height:1.4;margin-bottom:6px}
.top-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.trends-list{display:flex;flex-direction:column;gap:12px}
.trend-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;gap:14px}
.trend-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--surface2);flex-shrink:0}
.trend-title{font-size:14px;font-weight:600;margin-bottom:5px}.trend-desc{font-size:12px;color:var(--muted);line-height:1.55}
.trend-evidence{margin-top:7px;font-size:11px;color:var(--c-accent,#3b82f6);font-style:italic}
.ab-badge{background:#7c3aed22;border:1px solid #7c3aed55;color:#a78bfa;border-radius:5px;padding:1px 7px;font-size:10px;font-weight:700;margin-left:6px}
.reco-box{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--c-accent,#3b82f6);border-radius:0 12px 12px 0;padding:18px;margin-top:20px}
.reco-title{font-size:13px;font-weight:700;margin-bottom:8px}.reco-content{font-size:12px;color:var(--muted);line-height:1.6}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.section-head h2{font-size:15px;font-weight:700}
.section-count{background:var(--surface2);border-radius:20px;padding:2px 10px;font-size:11px;color:var(--muted)}
.insight-box{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--c-accent,#3b82f6);border-radius:0 10px 10px 0;padding:14px;margin-bottom:14px}
.insight-box h3{font-size:12px;font-weight:600;margin-bottom:5px}.insight-box p{font-size:11px;color:var(--muted);line-height:1.55}
.demo-banner{background:linear-gradient(135deg,#78350f,#92400e);border:1px solid #d97706;border-radius:12px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.demo-badge{background:#f59e0b;color:#0f1117;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:800;letter-spacing:.5px;flex-shrink:0}
.demo-text{font-size:12px;color:#fcd34d;line-height:1.5}
.atm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.atm-kpi{background:var(--surface);border:1px solid var(--border);border-top:3px solid #f59e0b;border-radius:12px;padding:16px}
.atm-kpi-val{font-size:24px;font-weight:800;color:#f59e0b}.atm-kpi-label{font-size:11px;color:var(--muted);margin-top:3px}
.atm-kpi-note{font-size:10px;color:var(--muted);margin-top:5px;font-style:italic}
.bullets{display:flex;flex-direction:column;gap:8px;margin-bottom:20px}
.bullet{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5}
@media(max-width:600px){.content{padding:14px}.ads-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">🎲</div>
    <div>
      <div class="logo-text">ATM Gaming · Dashboard Veille</div>
      <div class="logo-sub">Semaine du ${a.weekLabel}</div>
    </div>
  </div>
  <div class="header-right">
    <div class="date-badge">📅 ${date}</div>
    <div class="live-badge">● LIVE</div>
  </div>
</div>

<div class="country-tabs" id="countryTabs">${countryTabsHtml}</div>

<div class="sub-tabs" id="subTabs">
  <button class="stab active" onclick="switchSubTab('resume')">📊 Résumé</button>
  <button class="stab" onclick="switchSubTab('nouvelles')">🆕 Nouvelles Pubs</button>
  <button class="stab" onclick="switchSubTab('top')">🏆 Top Pubs</button>
  <button class="stab" onclick="switchSubTab('tendances')">📈 Tendances</button>
  <button class="stab" onclick="switchSubTab('tests')">🧪 Tests Créatifs</button>
</div>

<div class="content" id="mainContent"></div>

<script>
const ANALYSIS = ${JSON.stringify(a)};
const C_META = {
  global:{flag:'🌍',name:'Global',accent:'#8b5cf6'},
  fr:{flag:'🇫🇷',name:'France',accent:'#3b82f6'},
  dach:{flag:'🇩🇪',name:'DACH',accent:'#ef4444'},
  uk:{flag:'🇬🇧',name:'UK',accent:'#f97316'},
  us:{flag:'🇺🇸',name:'US/EN',accent:'#10b981'},
  atm:{flag:'📊',name:'ATM Gaming',accent:'#f59e0b'}
};
const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣'];

let currentCountry = 'global';
let currentSubTab = 'resume';
let adFilterBrand = 'all';
const charts = {};

function destroyCharts() {
  Object.values(charts).forEach(c => c && c.destroy());
  Object.keys(charts).forEach(k => delete charts[k]);
}

function getAccent() { return C_META[currentCountry]?.accent || '#3b82f6'; }

function switchCountry(c) {
  currentCountry = c;
  currentSubTab = 'resume';
  adFilterBrand = 'all';
  document.querySelectorAll('.ctab').forEach(t => t.classList.toggle('active', t.dataset.country === c));
  const accent = getAccent();
  document.querySelectorAll('.ctab.active').forEach(t => t.style.setProperty('--c-accent', accent));
  document.getElementById('mainContent').style.setProperty('--c-accent', accent);
  const st = document.getElementById('subTabs');
  st.style.display = c === 'atm' ? 'none' : 'flex';
  document.querySelectorAll('.stab').forEach((t, i) => t.classList.toggle('active', i === 0));
  destroyCharts();
  if (c === 'atm') renderATM();
  else render();
}

function switchSubTab(tab) {
  currentSubTab = tab;
  const order = ['resume','nouvelles','top','tendances','tests'];
  document.querySelectorAll('.stab').forEach((t, i) => t.classList.toggle('active', order[i] === tab));
  destroyCharts();
  render();
}

function render() {
  const D = ANALYSIS.countries[currentCountry];
  if (!D) return;
  const mc = document.getElementById('mainContent');
  mc.style.setProperty('--c-accent', getAccent());
  switch(currentSubTab) {
    case 'resume':    mc.innerHTML = renderResume(D); initCharts(D); break;
    case 'nouvelles': mc.innerHTML = renderNouvelles(D); break;
    case 'top':       mc.innerHTML = renderTop(D); break;
    case 'tendances': mc.innerHTML = renderTendances(D); break;
    case 'tests':     mc.innerHTML = renderTests(D); break;
  }
}

// ── RÉSUMÉ ──────────────────────────────────────────────────────────
function renderResume(D) {
  const accent = getAccent();
  const cm = C_META[currentCountry];
  const kpis = [
    { val: D.adsCount||0, label: 'Pubs détectées', delta: (D.brands||[]).length+' marques', dir:'neutral' },
    { val: D.liveCount||0, label: 'Pubs live', delta: Math.round(((D.liveCount||0)/(D.adsCount||1))*100)+'% taux live', dir:'up' },
    { val: (D.topAds||[]).filter(a=>a.live).length, label: 'Top ads actives', delta: 'dernière semaine', dir:'neutral' },
    { val: (D.creativeTests||[]).length, label: 'Tests A/B détectés', delta: 'minimum 3 requis', dir:'neutral' },
  ];
  const kpiHtml = kpis.map(k => \`<div class="kpi-card"><div class="kpi-value">\${k.val}</div><div class="kpi-label">\${k.label}</div><div class="kpi-delta \${k.dir}">\${k.dir==='up'?'↑':'·'} \${k.delta}</div></div>\`).join('');
  const brandsHtml = (D.brands||[]).slice(0,6).map(b => \`
    <div class="brand-card">
      <div class="brand-info" style="flex:1">
        <div class="brand-name">\${b.name}</div>
        <div class="brand-meta">\${b.adsCount||0} pubs · \${b.liveCount||0} live · \${b.formats||''}</div>
        <div class="brand-meta" style="margin-top:2px">\${b.topAngle||''}</div>
        <div class="brand-tags">\${(b.tags||[]).map(t=>\`<span class="tag \${t}">\${t==='live'?'● Live':t==='hot'?'🔥 Hot':'✨ Nouveau'}</span>\`).join('')}</div>
      </div>
    </div>\`).join('');

  return \`
    <div class="section-head"><h2>\${cm.flag} Résumé — \${ANALYSIS.weekLabel}</h2></div>
    <div class="kpi-grid">\${kpiHtml}</div>
    <div class="charts-grid">
      <div class="chart-card"><div class="chart-title">Formats</div><div class="chart-wrap"><canvas id="cFormats"></canvas></div></div>
      <div class="chart-card"><div class="chart-title">Activité par marque</div><div class="chart-wrap"><canvas id="cBrands"></canvas></div></div>
    </div>
    <div class="section-head"><h2>Marques surveillées</h2><span class="section-count">\${(D.brands||[]).length}</span></div>
    <div class="brands-grid">\${brandsHtml}</div>\`;
}

function initCharts(D) {
  const accent = getAccent();
  const gray = 'rgba(255,255,255,0.1)';
  const ads = D.topAds || [];
  const fmts = {}, brands = {};
  ads.forEach(ad => {
    fmts[ad.format] = (fmts[ad.format]||0)+1;
    brands[ad.brand] = (brands[ad.brand]||0)+1;
  });
  const pal = [accent,'#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4'];
  const fc = document.getElementById('cFormats');
  if (fc) {
    charts.formats = new Chart(fc, {
      type:'doughnut',
      data:{labels:Object.keys(fmts),datasets:[{data:Object.values(fmts),backgroundColor:pal,borderWidth:0}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:'#9398a5',font:{size:10}}}}}
    });
  }
  const bc = document.getElementById('cBrands');
  if (bc) {
    const bArr = Object.entries(brands).sort((a,b)=>b[1]-a[1]);
    charts.brands = new Chart(bc, {
      type:'bar',
      data:{labels:bArr.map(e=>e[0].split(' ')[0]),datasets:[{data:bArr.map(e=>e[1]),backgroundColor:accent+'aa',borderRadius:4}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#9398a5',font:{size:9}},grid:{color:gray}},y:{ticks:{color:'#9398a5',font:{size:9}},grid:{color:gray}}}}
    });
  }
}

// ── NOUVELLES PUBS ───────────────────────────────────────────────────
function renderNouvelles(D) {
  const ads = D.topAds || [];
  const brands = [...new Set(ads.map(a=>a.brand))];
  const filterHtml = \`<span style="font-size:11px;color:var(--muted)">Marque:</span>
    <button class="filter-btn active" onclick="setAdFilter('all',this)">Toutes</button>
    \${brands.map(b=>\`<button class="filter-btn" onclick="setAdFilter('\${b.replace(/'/g,'').replace(/[^\\w]/g,'_')}',this)" data-brand="\${b}">\${b.split(' ')[0]}</button>\`).join('')}\`;
  const adsHtml = ads.map(ad => adCard(ad)).join('');
  return \`
    <div class="section-head"><h2>Pubs de la semaine</h2><span class="section-count">\${ads.length} ads</span></div>
    <div class="ads-controls">\${filterHtml}</div>
    <div class="ads-grid" id="adsGrid">\${adsHtml}</div>\`;
}

window.setAdFilter = function(f, el) {
  adFilterBrand = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const D = ANALYSIS.countries[currentCountry];
  const ads = (D?.topAds||[]).filter(ad => f==='all' || ad.brand.replace(/'/g,'').replace(/[^\\w]/g,'_')===f || ad.brand.split(' ')[0]===f);
  document.getElementById('adsGrid').innerHTML = ads.map(ad=>adCard(ad)).join('');
};

// ── TOP PUBS ─────────────────────────────────────────────────────────
function renderTop(D) {
  const ads = [...(D.topAds||[])].sort((a,b)=>b.days-a.days);
  const html = ads.map((ad,i) => \`
    <div class="top-item">
      <div class="top-rank">\${MEDALS[i]||'#'+(i+1)}</div>
      \${ad.img?\`<img class="top-img" src="\${ad.img}" onerror="this.style.display='none'" alt="">\`:'<div class="top-img" style="display:flex;align-items:center;justify-content:center;font-size:22px">🎯</div>'}
      <div class="top-body">
        <div class="top-brand">\${ad.brand} · \${ad.format} · \${ad.live?'<span style="color:#4ade80">● Live</span>':'Terminée'}</div>
        <div class="top-hook">\${(ad.hook||'').replace(/\\n/g,' ').substring(0,150)}</div>
        <div class="top-meta">
          <span class="ad-fmt">\${ad.format}</span>
          <span class="ad-days">⏱ \${ad.days}j</span>
          <a href="\${ad.url}" target="_blank" style="font-size:11px;color:var(--c-accent)">Voir sur Foreplay →</a>
        </div>
      </div>
    </div>\`).join('');
  return \`
    <div class="insight-box"><h3>Comment lire ce classement</h3><p>Une pub qui dure = une pub qui convertit. Ce sont vos références prioritaires à analyser et à s'inspirer.</p></div>
    <div class="section-head"><h2>Top pubs — classées par durée d'activité</h2></div>
    <div class="top-list">\${html}</div>\`;
}

// ── TENDANCES ────────────────────────────────────────────────────────
function renderTendances(D) {
  const html = (D.trends||[]).map((t,i) => \`
    <div class="trend-card">
      <div class="trend-icon">\${t.icon||'📌'}</div>
      <div style="flex:1">
        <div class="trend-title"><span style="color:var(--c-accent);font-size:18px;font-weight:800;margin-right:4px">\${i+1}.</span>\${t.title}</div>
        <div class="trend-desc">\${t.desc}</div>
        <div class="trend-evidence">📎 \${t.evidence||''}</div>
      </div>
    </div>\`).join('');
  const reco = D.recommendation;
  const recoHtml = reco ? \`
    <div class="reco-box">
      <div class="reco-title">💡 Action recommandée pour ATM Gaming (priorité \${reco.priority||'Haute'})</div>
      <div class="reco-content"><strong>\${reco.product}</strong> · Format : <strong>\${reco.format}</strong><br>
      Hook suggéré : <em>"\${reco.hook}"</em><br>Inspiré de : \${reco.inspiration}</div>
    </div>\` : '';
  return \`
    <div class="section-head"><h2>Tendances de la semaine</h2><span class="section-count">\${(D.trends||[]).length} tendances</span></div>
    <div class="trends-list">\${html}\${recoHtml}</div>\`;
}

// ── TESTS CRÉATIFS ────────────────────────────────────────────────────
function renderTests(D) {
  const tests = D.creativeTests || [];
  const html = tests.map(t => \`
    <div class="trend-card" style="border-left:3px solid var(--c-accent)">
      <div class="trend-icon" style="color:var(--c-accent)">🧪</div>
      <div style="flex:1">
        <div class="trend-title">\${t.title} <span class="ab-badge">A/B · \${t.count} créas</span></div>
        <div class="trend-desc" style="margin-top:5px">\${t.hook}</div>
        <div style="margin-top:6px;font-size:11px;color:var(--muted)">Marque : \${t.brand}</div>
      </div>
    </div>\`).join('');
  return \`
    <div class="insight-box"><h3>Pourquoi surveiller les A/B tests concurrents ?</h3><p>Quand un concurrent lance 3–7 variantes en simultané, il teste ce qui convertit. Les créas encore actives la semaine suivante = gagnantes. Vous apprenez sans dépenser.</p></div>
    <div class="section-head"><h2>Tests créatifs détectés</h2><span class="section-count">\${tests.length} tests</span></div>
    <div class="trends-list">\${html}</div>\`;
}

// ── ATM PERFS ──────────────────────────────────────────────────────────
function renderATM() {
  const atm = ANALYSIS.atm || {};
  const mc = document.getElementById('mainContent');
  mc.style.setProperty('--c-accent', '#f59e0b');
  const brandsHtml = (atm.brands||[]).map(b => \`
    <div class="brand-card">
      <div style="flex:1">
        <div class="brand-name">\${b.name}</div>
        <div class="brand-meta">\${b.market||''}</div>
        <div class="brand-meta">\${b.adsCount||0} pubs · \${b.liveCount||0} live · \${b.formats||''}</div>
        <div class="brand-meta" style="margin-top:2px">\${b.topAngle||''}</div>
        <div class="brand-tags">\${(b.tags||[]).map(t=>\`<span class="tag \${t}">\${t==='live'?'● Live':'✨ Nouveau'}</span>\`).join('')}</div>
      </div>
    </div>\`).join('');
  const topHtml = (atm.topAds||[]).map(ad => adCard(ad, '#f59e0b')).join('');
  const insightsHtml = (atm.insights||[]).map(ins => \`
    <div class="trend-card">
      <div class="trend-icon">\${ins.icon||'💡'}</div>
      <div style="flex:1">
        <div class="trend-title">\${ins.title}</div>
        <div class="trend-desc">\${ins.desc}</div>
        <div class="trend-evidence">📎 \${ins.evidence||''}</div>
      </div>
    </div>\`).join('');

  const hasMetaData = atm.spend != null && atm.spend > 0;
  const bannerHtml = hasMetaData
    ? \`<div class="demo-banner" style="border-left-color:#10b981;background:rgba(16,185,129,.08)"><span class="demo-badge" style="background:#10b981">META ADS LIVE</span><div class="demo-text">Données Meta Ads réelles — semaine du \${ANALYSIS.weekLabel}.</div></div>\`
    : \`<div class="demo-banner"><span class="demo-badge">FOREPLAY DATA</span><div class="demo-text">Données Foreplay Spyder. Ajoutez META_ACCESS_TOKEN et META_AD_ACCOUNT_ID comme secrets GitHub pour le CPA/ROAS réel.</div></div>\`;

  const campaignsHtml = (atm.topCampaigns||[]).length > 0 ? \`
    <div class="section-head" style="margin-top:20px"><h2>🎯 Top campagnes Meta cette semaine</h2></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      \${(atm.topCampaigns||[]).map(c => \`
        <div style="background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="font-weight:600;color:#e2e8f0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${c.name}</div>
          <div style="display:flex;gap:16px;flex-shrink:0;font-size:13px">
            <span style="color:#f59e0b;font-weight:700">\${c.spend?.toFixed(0)}€</span>
            \${c.roas ? \`<span style="color:#10b981">ROAS \${c.roas?.toFixed(1)}x</span>\` : ''}
            \${c.cpa ? \`<span style="color:#60a5fa">CPA \${c.cpa?.toFixed(0)}€</span>\` : ''}
            \${c.purchases ? \`<span style="color:#a78bfa">\${c.purchases} achats</span>\` : ''}
          </div>
          <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:\${c.status==='ACTIVE'?'rgba(16,185,129,.2)':'rgba(107,114,128,.2)'};color:\${c.status==='ACTIVE'?'#10b981':'#9ca3af'}">\${c.status==='ACTIVE'?'Live':'Pausée'}</span>
        </div>\`).join('')}
    </div>\` : '';

  mc.innerHTML = \`
    \${bannerHtml}
    <div class="section-head"><h2>📊 Mes Performances ATM Gaming — \${ANALYSIS.weekLabel}</h2></div>
    <div class="atm-kpis">
      <div class="atm-kpi"><div class="atm-kpi-val">\${atm.totalAds||0}</div><div class="atm-kpi-label">Pubs actives total</div><div class="atm-kpi-note">\${(atm.brands||[]).map(b=>b.name.split(' ')[0]+' '+b.adsCount).join(' · ')}</div></div>
      <div class="atm-kpi"><div class="atm-kpi-val">\${atm.liveAds||0}</div><div class="atm-kpi-label">Pubs live en ce moment</div><div class="atm-kpi-note">\${Math.round(((atm.liveAds||0)/(atm.totalAds||1))*100)}% du parc actif</div></div>
      \${hasMetaData ? \`
        <div class="atm-kpi" style="border-top-color:#f59e0b"><div class="atm-kpi-val" style="color:#f59e0b">\${atm.spend?.toFixed(0)}€</div><div class="atm-kpi-label">Budget dépensé</div><div class="atm-kpi-note">7 derniers jours</div></div>
        <div class="atm-kpi" style="border-top-color:#10b981"><div class="atm-kpi-val" style="color:#10b981">\${atm.roas?.toFixed(1) || '—'}x</div><div class="atm-kpi-label">ROAS</div><div class="atm-kpi-note">Retour sur dépenses</div></div>
        <div class="atm-kpi" style="border-top-color:#60a5fa"><div class="atm-kpi-val" style="color:#60a5fa">\${atm.cpa?.toFixed(0) || '—'}€</div><div class="atm-kpi-label">CPA moyen</div><div class="atm-kpi-note">\${atm.purchases||0} achats</div></div>
        <div class="atm-kpi" style="border-top-color:#a78bfa"><div class="atm-kpi-val" style="color:#a78bfa">\${atm.ctr?.toFixed(1)||'—'}%</div><div class="atm-kpi-label">CTR moyen</div><div class="atm-kpi-note">\${((atm.impressions||0)/1000).toFixed(0)}k impressions</div></div>
      \` : \`
        <div class="atm-kpi"><div class="atm-kpi-val">\${(atm.brands||[]).length}</div><div class="atm-kpi-label">Marques en campagne</div><div class="atm-kpi-note">suivi hebdomadaire</div></div>
        <div class="atm-kpi" style="border-top-color:#6b7280"><div class="atm-kpi-val" style="color:#6b7280">—</div><div class="atm-kpi-label">CPA / ROAS</div><div class="atm-kpi-note">Ajouter META_ACCESS_TOKEN</div></div>
      \`}
    </div>
    <div class="section-head"><h2>Mes marques actives</h2></div>
    <div class="brands-grid">\${brandsHtml}</div>
    \${campaignsHtml}
    <div class="section-head" style="margin-top:20px"><h2>Meilleures pubs ATM Gaming</h2></div>
    <div class="ads-grid">\${topHtml}</div>
    <div class="section-head" style="margin-top:20px"><h2>Insights stratégiques</h2></div>
    <div class="trends-list">\${insightsHtml}</div>\`;
}

// ── AD CARD ────────────────────────────────────────────────────────────
function adCard(ad, forceAccent) {
  const acc = forceAccent || getAccent();
  const url = ad.url || ('https://app.foreplay.co/discovery?ad='+ad.id);
  const media = ad.img
    ? (ad.format==='VIDEO'
       ? \`<div class="ad-thumb"><img src="\${ad.img}" onerror="this.parentNode.innerHTML='<span style=\\"font-size:28px\\">🎬</span>'"><div class="vplay"><div class="vplay-icon">▶</div></div></div>\`
       : \`<div class="ad-thumb"><img src="\${ad.img}" onerror="this.parentNode.innerHTML='<span style=\\"font-size:28px\\">🖼️</span>'"></div>\`)
    : \`<div class="ad-thumb" style="font-size:28px">\${ad.format==='VIDEO'?'🎬':'🖼️'}</div>\`;
  return \`
    <div class="ad-card" onclick="window.open('\${url}','_blank')" style="--c-accent:\${acc}">
      \${media}
      <div class="ad-body">
        <div class="ad-brand">\${ad.brand||''}</div>
        <div class="ad-desc">\${(ad.hook||'').replace(/\\n/g,' ')}</div>
        <div class="ad-footer">
          <span class="ad-fmt">\${ad.format||''}</span>
          <span class="ad-days">⏱ \${ad.days||0}j</span>
          \${ad.live?'<div class="ad-live"></div>':''}
        </div>
        <a class="ad-link" href="\${url}" target="_blank" onclick="event.stopPropagation()">Voir sur Foreplay →</a>
      </div>
    </div>\`;
}

// ── INIT ────────────────────────────────────────────────────────────────
document.querySelectorAll('.ctab').forEach(t => {
  t.addEventListener('click', () => {
    t.style.setProperty('--c-accent', C_META[t.dataset.country]?.accent || '#3b82f6');
  });
});
document.getElementById('mainContent').style.setProperty('--c-accent', '#8b5cf6');
render();
</script>
</body>
</html>`;
}

// ─── Livraison Slack ────────────────────────────────────────────────────────────

async function slackPost(method, body, isForm = false) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      ...(isForm
        ? { 'Content-Type': 'application/x-www-form-urlencoded' }
        : { 'Content-Type': 'application/json' })
    },
    body: isForm ? new URLSearchParams(body).toString() : JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error [${method}]: ${data.error}`);
  return data;
}

async function postReportToSlack(analysis, htmlFilename, pageUrl) {
  const bullets = analysis.globalInsights.slice(0, 5).join('\n');
  const countryStats = Object.entries(analysis.countries)
    .map(([k, v]) => `${k === 'fr' ? '🇫🇷' : k === 'dach' ? '🇩🇪' : k === 'uk' ? '🇬🇧' : k === 'us' ? '🇺🇸' : '🌍'} ${v.adsCount} pubs`)
    .join(' · ');

  const linkBlock = pageUrl
    ? `\n\n🔗 *<${pageUrl}|Ouvrir le dashboard interactif →>*`
    : '\n\n📁 Rapport HTML joint en fil de discussion.';

  const mainMsg = await slackPost('chat.postMessage', {
    channel: SLACK_CHANNEL_ID,
    text: `*📊 Veille Concurrence ATM Gaming — semaine du ${analysis.weekLabel}*\n\n${bullets}\n\n${countryStats}${linkBlock}`,
    unfurl_links: false
  });

  const htmlContent = readFileSync(htmlFilename, 'utf8');
  const sizeBytes = Buffer.byteLength(htmlContent, 'utf8');

  const { upload_url, file_id } = await slackPost('files.getUploadURLExternal', {
    filename: htmlFilename,
    length: sizeBytes.toString()
  }, true);

  await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: htmlContent
  });

  await slackPost('files.completeUploadExternal', {
    files: JSON.stringify([{ id: file_id }]),
    channel_id: SLACK_CHANNEL_ID,
    thread_ts: mainMsg.ts,
    initial_comment: pageUrl
      ? '📁 Fichier HTML archivé ici. Utilise le lien ci-dessus pour le dashboard interactif.'
      : '📁 Ouvre ce fichier dans Chrome/Firefox pour le dashboard interactif complet.'
  }, true);

  console.log('✅ Rapport posté dans #veille-concu-fr');
}

// ─── Index GitHub Pages ─────────────────────────────────────────────────────────

function buildIndexPage() {
  if (!existsSync('docs')) return;
  const files = readdirSync('docs')
    .filter(f => f.startsWith('rapport-veille-') && f.endsWith('.html'))
    .sort().reverse();

  const rows = files.map(f => {
    const dateStr = f.replace('rapport-veille-concu-', '').replace('.html', '');
    const [y, m, d] = dateStr.split('-');
    const label = d && m && y
      ? new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : dateStr;
    return `<li><a href="${f}">${label}</a></li>`;
  }).join('\n    ');

  writeFileSync('docs/index.html', `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Veille Concurrence — ATM Gaming</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;max-width:700px;margin:60px auto;padding:0 24px}
h1{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}p{color:#94a3b8;margin-bottom:32px}
ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:12px}
li a{display:block;background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:16px 20px;color:#e2e8f0;text-decoration:none;font-weight:500;transition:all .2s}
li a:hover{border-color:#f59e0b;color:#fff}
li:first-child a::after{content:" — Dernière semaine";font-size:12px;color:#f59e0b;margin-left:8px}
</style>
</head>
<body>
<h1>🎲 Veille Concurrence ATM Gaming</h1>
<p>Dashboard multi-pays généré automatiquement chaque lundi et jeudi matin.</p>
<ul>${rows}</ul>
</body>
</html>`, 'utf8');
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 ATM Gaming — Veille concurrence v2 (dashboard multi-pays)\n');

  const data = await fetchAllData();
  if (data.competitors.length === 0) throw new Error('Aucune donnée concurrente récupérée. Vérifie ta clé API Foreplay.');

  const analysis = await analyzeWithClaude(data);
  const totalPays = Object.values(analysis.countries).reduce((n, c) => n + (c.adsCount||0), 0);
  console.log(`  → Analyse OK : ${totalPays} pubs · ${analysis.activeBrands} marques · ${Object.keys(analysis.countries).length} pays`);

  const today = new Date().toISOString().split('T')[0];
  const filename = `rapport-veille-concu-${today}.html`;
  const html = generateHTML(analysis);

  writeFileSync(filename, html, 'utf8');

  if (!existsSync('docs')) mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/${filename}`, html, 'utf8');
  buildIndexPage();
  console.log(`  → HTML sauvegardé : ${filename} + docs/${filename}`);

  const pageUrl = GITHUB_PAGES_BASE ? `${GITHUB_PAGES_BASE}/${filename}` : '';
  if (pageUrl) console.log(`  → Lien GitHub Pages : ${pageUrl}`);

  await postReportToSlack(analysis, filename, pageUrl);
}

main().catch(err => {
  console.error('❌ Erreur fatale:', err.message);
  process.exit(1);
});
