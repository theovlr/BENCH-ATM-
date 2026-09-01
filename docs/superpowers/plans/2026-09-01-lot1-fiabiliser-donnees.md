# Lot 1 — Fiabiliser les données — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corriger les bugs de données confirmés dans `SPEC-BENCHMARK-V2.md` §2 (longévité toujours nulle, hooks vides, pagination plafonnée, classification par marché fausse, filtrage ATM destructif) et poser le schéma `Ad` canonique, sans toucher au pipeline en 4 scripts (Lot 2), au dashboard interactif (Lot 3/4) ni au ROAS Meta (Lot 6).

**Architecture:** Trois nouveaux modules purs et testés (`lib/normalize.mjs`, `lib/classify.mjs`, `lib/metrics.mjs`) viennent s'intercaler entre l'appel API Foreplay (déjà dans `lib/foreplay-shared.mjs`, corrigé) et la sortie (`benchmark-ugc.mjs`, adapté ; `run-report.mjs`, seulement dédupliqué). `benchmark-ugc.mjs` écrit désormais `data/dataset-<date>.json` conforme au schéma `Ad` de la spec §4.3, en plus de ses sorties existantes.

**Tech Stack:** Node 20, ES modules, `node:test` + `node:assert` (aucune dépendance de test à installer), `openai` (déjà en place).

**Spec:** `/Users/guilliancelle/Downloads/SPEC-BENCHMARK-V2.md` (§2, §3, §4.3, §9 Lot 1, §10 critères d'acceptation Lot 1) et `/Users/guilliancelle/Downloads/CLAUDE.md`.

## Global Constraints

- Jamais de tiret cadratin (`—`) dans les sorties générées (prompts inclus) : virgule, deux-points ou parenthèses.
- Tout en français dans l'UI, les logs et les sorties LLM.
- Pas de valeur de repli inventée sur une donnée absente : champ manquant = `null`, jamais `|| 0` / `|| 'Inconnu'`. Exception documentée : `running_days` suit littéralement le correctif de la spec §2.1 (`running_duration?.days ?? 0`) — voir Tâche 2.
- Les marques ATM se **taguent** (`owner: 'atm' | 'competitor'`), ne se filtrent jamais.
- Le LLM ne compte pas : toute statistique vit dans `lib/metrics.mjs`, pure et testée.
- Toute `evidence` LLM doit être validable contre les IDs réellement présents dans le dataset (le garde-fou de validation applicative est Lot 7 ; ce lot pose seulement le dataset propre qui le rendra possible).
- `Promise.allSettled` reste le pattern pour les appels Foreplay parallèles par marque.
- `limit` sur `/api/spyder/brand/ads` monte à 250 avec pagination par `metadata.cursor` ; `limit` sur `/api/spyder/brands` plafonne à 10 (déjà correct depuis la session précédente).
- Ne pas réécrire `run-report.mjs` : seule sa duplication de code disparaît (import de `lib/foreplay-shared.mjs`), son prompt Claude/OpenAI, sa génération HTML et son envoi Slack restent intacts à l'identique.
- 1 crédit Foreplay par pub retournée sur `brand/ads` : `MAX_ADS_PER_BRAND` doit être configurable (variable d'env, défaut 250) pour ne pas exploser la consommation par accident pendant le développement.

---

## File Structure

```
config/
  atm-brands.json          # NOUVEAU — mapping mot-clé -> produit ATM (fusion OWN_BRAND_KEYWORDS + EXTRA_OWN_BRAND_KEYWORDS)
lib/
  foreplay-shared.mjs       # MODIFIÉ — pagination 250+curseur, normalisation format/date, getBrandAds legacy corrigé (pour run-report.mjs), + getBrandAdsRaw
  normalize.mjs             # NOUVEAU — raw API -> schéma Ad canonique (pur)
  classify.mjs              # NOUVEAU — market (cascade), owner, in_scope (pur)
  metrics.mjs                # NOUVEAU — nullLongevityRate, emptyHookRate, countByOwner, countByMarket, brandsExceeding (pur)
run-report.mjs               # MODIFIÉ a minima — importe lib/foreplay-shared.mjs au lieu de sa copie inline
benchmark-ugc.mjs            # MODIFIÉ — fetch -> normalize -> classify -> garde-fous -> data/dataset-<date>.json, tag ATM au lieu de filtrer
.env.example                 # NOUVEAU — variables documentées sans valeurs
tests/
  normalize.test.mjs         # NOUVEAU
  classify.test.mjs          # NOUVEAU
  metrics.test.mjs           # NOUVEAU
package.json                 # MODIFIÉ — script "test": "node --test tests/"
```

---

## Task 1 : `config/atm-brands.json` + `.env.example`

**Files:**
- Create: `config/atm-brands.json`
- Create: `.env.example`
- Test: aucun (données statiques, validées par Task 3 `classify.test.mjs`)

**Interfaces:**
- Produces : un tableau `[{ keyword: string, product: string }]` importable via `import atmBrands from '../config/atm-brands.json' with { type: 'json' }` (import JSON natif Node 20+ avec l'attribut `type: 'json'`, requis depuis Node 20 pour les imports JSON en ESM).

**Contexte factuel vérifié dans cette session** (à ne pas re-deviner) : la marque Foreplay Spyder nommée `HOLY` (id `aklQfSP0ipFpQJoov2TA`) n'est **pas** Mouton Mouton / Holy Sheep — c'est la marque de boissons énergisantes allemande "HOLY Energy" (`category: "Food and drink"`, `niches: ["Food/Drink"]`, site `weareholy.com`). Elle doit rester hors périmètre (`in_scope: false`, Task 3), ne jamais être ajoutée à `atm-brands.json`. Les marques ATM confirmées comme suivies dans Spyder à ce jour : `Pili Pili Game`, `Quickstop Game`, `Speedbac - jeu petit bac`, `Osmooz`. Les autres produits du catalogue ne sont pas actuellement visibles dans les 60 marques suivies (soit non trackées sur Spyder, soit sous un nom différent) : on garde leurs mots-clés dans le mapping pour le jour où ils apparaîtront, sans prétendre qu'ils sont déjà détectés.

- [ ] **Étape 1 : créer `config/atm-brands.json`**

```json
[
  { "keyword": "pili pili", "product": "Pili Pili" },
  { "keyword": "quickstop", "product": "Quickstop" },
  { "keyword": "speedbac", "product": "Speedbac" },
  { "keyword": "jumo", "product": "JUMO" },
  { "keyword": "mouton mouton", "product": "Mouton Mouton (Holy Sheep)" },
  { "keyword": "holy sheep", "product": "Mouton Mouton (Holy Sheep)" },
  { "keyword": "smash it", "product": "Smash It" },
  { "keyword": "play hit", "product": "Play-Hit" },
  { "keyword": "play-hit", "product": "Play-Hit" },
  { "keyword": "little secret", "product": "Little Secret" },
  { "keyword": "rank king", "product": "Rank King" },
  { "keyword": "osmooz", "product": "Osmooz" },
  { "keyword": "intimoos", "product": "Intimoos" },
  { "keyword": "atm gaming", "product": null }
]
```

Note : pas de mot-clé `"holy"` seul (voir contexte factuel ci-dessus : matcherait la marque de boissons énergisantes `HOLY`, pas Holy Sheep). `"holy sheep"` en toutes lettres suffit tant que le nom Spyder exact du produit n'est pas confirmé.

- [ ] **Étape 2 : créer `.env.example`**

```
OPENAI_API_KEY=
FOREPLAY_API_KEY=
SLACK_BOT_TOKEN=
META_ACCESS_TOKEN=
META_AD_ACCOUNT_ID=
META_ACCESS_TOKEN_2=
META_AD_ACCOUNT_ID_2=
MAX_ADS_PER_BRAND=250
```

- [ ] **Étape 3 : vérifier que `.env.example` ne contient aucune valeur, puis commit**

```bash
grep -E '=.+' .env.example && echo "FAIL: valeur trouvée" || echo "OK: fichier vide de valeurs"
git add config/atm-brands.json .env.example
git commit -m "Ajoute le mapping des marques ATM et .env.example (lot 1)"
```

---

## Task 2 : `lib/normalize.mjs` — schéma `Ad` canonique

**Files:**
- Create: `lib/normalize.mjs`
- Test: `tests/normalize.test.mjs`

**Interfaces:**
- Consumes : un objet `rawAd` (forme brute `/api/spyder/brand/ads`, cf. spec §3.2) et un objet `rawBrand` (forme brute `/api/spyder/brands`, cf. spec §3.1).
- Produces : `normalizeAd(rawAd, rawBrand) -> Ad` (le type `Ad` de la spec §4.3, **sans** `owner`, `atm_product`, `market`, `market_confidence`, `market_source`, `in_scope` — ces champs sont ajoutés ensuite par `classify.mjs`, Task 3, pour garder la séparation données API / logique métier). `normalizeAd` renvoie ces six champs avec des valeurs neutres (`owner: null`, `atm_product: null`, `market: null`, `market_confidence: null`, `market_source: null`, `in_scope: null`) pour que le type soit stable avant classification.

- [ ] **Étape 1 : écrire les tests**

```javascript
// tests/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAd, normalizeFormat, resolveHook } from '../lib/normalize.mjs';

const rawBrand = {
  id: 'usPYvIlbycnetYwNgX6P', name: 'Pili Pili Game',
  category: 'Board Game', niches: [], websites: [],
  avatar: 'https://example.com/avatar.png', ad_library_id: '801582916375662',
};

test('normalizeAd mappe running_duration.days vers running_days', () => {
  const rawAd = {
    id: 'Vw4AW8lKzYR0KJ25xJAc', ad_id: '1833680067520702', display_format: 'video',
    live: false, running_duration: { days: 217 }, started_running: 1760943600000,
    headline: 'Pili Pili', description: 'desc', link_url: 'https://atmgaming.com/pilipili-uk',
    languages: ['English'], niches: ['Entertainment', 'Games'], product_category: 'card games',
    publisher_platform: ['facebook'], emotional_drivers: { belonging: 8 },
    persona: { age: 'unknown', gender: 'both' }, video_duration: 25.1,
    cta_type: 'PLAY_GAME', cta_title: '', thumbnail: 'https://example.com/t.jpg',
    foreplay_url: 'https://app.foreplay.co/discovery?ad=Vw4AW8lKzYR0KJ25xJAc',
  };
  const ad = normalizeAd(rawAd, rawBrand);
  assert.equal(ad.running_days, 217);
  assert.equal(ad.format, 'VIDEO');
  assert.equal(ad.hook, 'Pili Pili');
  assert.equal(ad.headline, 'Pili Pili');
  assert.equal(ad.brand_name, 'Pili Pili Game');
  assert.equal(ad.page_id, '801582916375662');
  assert.equal(ad.started_running, new Date(1760943600000).toISOString());
  assert.equal(ad.live, false);
  assert.deepEqual(ad.emotional_drivers, { belonging: 8 });
  assert.equal(ad.owner, null);
});

test('normalizeAd renvoie running_days = 0 (pas null) quand running_duration est absent, par choix explicite de la spec §2.1', () => {
  const ad = normalizeAd({ id: 'x', display_format: 'IMAGE' }, rawBrand);
  assert.equal(ad.running_days, 0);
});

test('normalizeAd ne fabrique jamais de foreplay_url différente de celle fournie par l’API', () => {
  const ad = normalizeAd({ id: 'x', foreplay_url: 'https://app.foreplay.co/discovery?ad=x' }, rawBrand);
  assert.equal(ad.foreplay_url, 'https://app.foreplay.co/discovery?ad=x');
});

test('normalizeAd construit un foreplay_url de secours seulement si absent', () => {
  const ad = normalizeAd({ id: 'x' }, rawBrand);
  assert.equal(ad.foreplay_url, 'https://app.foreplay.co/discovery?ad=x');
});

test('normalizeFormat met en majuscules et retombe sur OTHER si inconnu', () => {
  assert.equal(normalizeFormat('video'), 'VIDEO');
  assert.equal(normalizeFormat('DCO'), 'DCO');
  assert.equal(normalizeFormat('slideshow'), 'OTHER');
  assert.equal(normalizeFormat(undefined), 'OTHER');
});

test('resolveHook suit la cascade headline -> description -> title -> name -> transcription -> vide', () => {
  assert.equal(resolveHook({ headline: 'H' }), 'H');
  assert.equal(resolveHook({ description: 'D' }), 'D');
  assert.equal(resolveHook({ title: 'T' }), 'T');
  assert.equal(resolveHook({ name: 'N' }), 'N');
  assert.equal(resolveHook({ transcription: 'Premiers mots ici et encore plus de texte après' }),
    'Premiers mots ici et encore plus de texte après'.split(' ').slice(0, 12).join(' '));
  assert.equal(resolveHook({}), '');
});
```

- [ ] **Étape 2 : lancer les tests, vérifier qu'ils échouent (module inexistant)**

```bash
node --test tests/normalize.test.mjs
```

Attendu : `ERR_MODULE_NOT_FOUND` sur `../lib/normalize.mjs`.

- [ ] **Étape 3 : implémenter `lib/normalize.mjs`**

```javascript
// lib/normalize.mjs
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
```

- [ ] **Étape 4 : lancer les tests, vérifier qu'ils passent**

```bash
node --test tests/normalize.test.mjs
```

- [ ] **Étape 5 : commit**

```bash
git add lib/normalize.mjs tests/normalize.test.mjs
git commit -m "Ajoute normalize.mjs : schéma Ad canonique, fix running_days et hook (lot 1)"
```

---

## Task 3 : `lib/classify.mjs` — marché, owner, in_scope

**Files:**
- Create: `lib/classify.mjs`
- Test: `tests/classify.test.mjs`

**Interfaces:**
- Consumes : un `Ad` produit par `normalizeAd` (Task 2), le `rawBrand` correspondant (pour `websites`, `category`), et `atmBrandsConfig` (Task 1, `config/atm-brands.json`).
- Produces : `classifyAd(ad, rawBrand, atmBrandsConfig) -> Ad` (nouvel objet, avec `owner`, `atm_product`, `market`, `market_confidence`, `market_source`, `in_scope` renseignés ; tous les autres champs inchangés).

**Corrections à couvrir (spec §2.4, tableau) :** `Dossiers_Criminels_Jeu` -> fr, `Jumboplay` -> nl, `Le Plus Proche Gagne` -> fr, `Dimoi` -> fr, `OutSmarted` -> uk, `Exploding Kittens` -> us, `Giochi Uniti` -> it, `Rocco Giocattoli` -> it, `Asmodee UK` -> uk. `The Ridge`, `Axel Arigato`, `Feastables` ne sont pas des jeux de société : ils doivent sortir via `in_scope: false`, pas via une règle de marché.

- [ ] **Étape 1 : écrire les tests**

```javascript
// tests/classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarket, classifyOwner, classifyInScope } from '../lib/classify.mjs';

const atmBrands = [
  { keyword: 'pili pili', product: 'Pili Pili' },
  { keyword: 'osmooz', product: 'Osmooz' },
];

test('classifyOwner tague une marque ATM connue', () => {
  const r = classifyOwner('Pili Pili Game', atmBrands);
  assert.equal(r.owner, 'atm');
  assert.equal(r.atm_product, 'Pili Pili');
});

test('classifyOwner tague competitor si aucun mot-clé ne matche', () => {
  const r = classifyOwner('Gigamic', atmBrands);
  assert.equal(r.owner, 'competitor');
  assert.equal(r.atm_product, null);
});

test('classifyMarket priorise la langue quand elle est non ambiguë', () => {
  const r = classifyMarket({ languages: ['French'], link_url: null }, { name: 'Une Marque', websites: [] });
  assert.equal(r.market, 'fr');
  assert.equal(r.market_confidence, 'high');
  assert.equal(r.market_source, 'language');
});

test('classifyMarket retombe sur link_url si la langue est anglaise (ambiguë UK/US/global)', () => {
  const r = classifyMarket(
    { languages: ['English'], link_url: 'https://atmgaming.com/pilipili-uk' },
    { name: 'Une Marque', websites: [] }
  );
  assert.equal(r.market, 'uk');
  assert.equal(r.market_source, 'link_url');
});

test('classifyMarket retombe sur le TLD du site marque si langue et link_url ne tranchent pas', () => {
  const r = classifyMarket({ languages: [], link_url: null }, { name: 'Une Marque', websites: ['https://savana-games.fr'] });
  assert.equal(r.market, 'fr');
  assert.equal(r.market_source, 'website_tld');
});

test('classifyMarket corrige Dossiers_Criminels_Jeu (underscores) en fr', () => {
  const r = classifyMarket({ languages: [], link_url: null }, { name: 'Dossiers_Criminels_Jeu', websites: [] });
  assert.equal(r.market, 'fr');
  assert.equal(r.market_source, 'brand_keyword');
});

test('classifyMarket corrige Jumboplay en nl', () => {
  const r = classifyMarket({ languages: [], link_url: null }, { name: 'Jumboplay', websites: [] });
  assert.equal(r.market, 'nl');
});

for (const [name, expected] of [
  ['Le Plus Proche Gagne', 'fr'], ['Dimoi', 'fr'], ['OutSmarted', 'uk'],
  ['Exploding Kittens', 'us'], ['Giochi Uniti', 'it'], ['Rocco Giocattoli', 'it'],
  ['Asmodee UK', 'uk'],
]) {
  test(`classifyMarket corrige ${name} en ${expected}`, () => {
    const r = classifyMarket({ languages: [], link_url: null }, { name, websites: [] });
    assert.equal(r.market, expected);
  });
}

test('classifyMarket renvoie unclassified (pas global) si aucun signal ne matche', () => {
  const r = classifyMarket({ languages: [], link_url: null }, { name: 'Marque Totalement Inconnue', websites: [] });
  assert.equal(r.market, 'unclassified');
  assert.equal(r.market_confidence, 'low');
});

test('classifyMarket garde global pour les marques réellement mondiales', () => {
  const r = classifyMarket({ languages: [], link_url: null }, { name: 'LEGO', websites: [] });
  assert.equal(r.market, 'global');
});

test('classifyInScope exclut HOLY (boissons énergisantes) via la catégorie, pas via le nom', () => {
  const inScope = classifyInScope(
    { niches: ['Food/Drink'], product_category: null },
    { category: 'Food and drink', name: 'HOLY' }
  );
  assert.equal(inScope, false);
});

test('classifyInScope accepte une pub jeux de société', () => {
  const inScope = classifyInScope(
    { niches: ['Entertainment', 'Games'], product_category: 'card games' },
    { category: 'Board Game', name: 'Pili Pili Game' }
  );
  assert.equal(inScope, true);
});

test('classifyInScope garde la liste noire comme filet de sécurité', () => {
  const inScope = classifyInScope(
    { niches: [], product_category: null },
    { category: 'App Page', name: 'Tinder' }
  );
  assert.equal(inScope, false);
});
```

- [ ] **Étape 2 : lancer les tests, vérifier l'échec**

```bash
node --test tests/classify.test.mjs
```

- [ ] **Étape 3 : implémenter `lib/classify.mjs`**

```javascript
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
  { market: 'us', keywords: ['wdym', 'what do you meme', 'hitster', 'kollide', 'feastables', 'exploding kittens'] },
  { market: 'global', keywords: ['lego', 'mattel', 'uno', 'hasbro', 'asmodee', 'ravensburger'] },
];

// Secteur jeu de société / entertainment. Vérifié en priorité sur les champs API
// (niches, product_category, category) — la liste noire ne reste qu'un filet de
// sécurité (spec §2.5), plus une source de vérité.
const IN_SCOPE_NICHES = ['games', 'entertainment', 'toys', 'board game'];
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

export function classifyMarket(ad, brand) {
  const [language] = ad.languages || [];
  if (language && LANGUAGE_TO_MARKET[language]) {
    return { market: LANGUAGE_TO_MARKET[language], market_confidence: 'high', market_source: 'language' };
  }

  const linkTld = extractTld(ad.link_url);
  if (linkTld && TLD_TO_MARKET[linkTld]) {
    return { market: TLD_TO_MARKET[linkTld], market_confidence: 'medium', market_source: 'link_url' };
  }
  const linkPath = (ad.link_url || '').toLowerCase();
  for (const [tld, market] of Object.entries(TLD_TO_MARKET)) {
    if (linkPath.includes(`/${tld}`) || linkPath.includes(`-${tld}`)) {
      return { market, market_confidence: 'medium', market_source: 'link_url' };
    }
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
```

Remarque d'implémentation sur `IRRELEVANT_KEYWORDS` : le mot-clé est repassé à `'holy'` seul (au lieu de `'holy energy'`) car le nom de marque réel suivi sur Spyder est exactement `HOLY`, pas `Holy Energy` (vérifié §Task 1). Comme `classifyInScope` vérifie d'abord `niches`/`category` (une boisson énergisante ne matche jamais `IN_SCOPE_NICHES`), ce mot-clé élargi ne peut pas exclure à tort une marque de jeu qui contiendrait accidentellement "holy" dans son nom : il ne s'applique qu'en filet de sécurité, après que le signal primaire a déjà tranché `looksInScope`.

- [ ] **Étape 4 : lancer les tests, vérifier qu'ils passent**

```bash
node --test tests/classify.test.mjs
```

- [ ] **Étape 5 : commit**

```bash
git add lib/classify.mjs tests/classify.test.mjs
git commit -m "Ajoute classify.mjs : cascade de marché, tag owner, in_scope (lot 1)"
```

---

## Task 4 : `lib/metrics.mjs` — garde-fous et critères d'acceptation

**Files:**
- Create: `lib/metrics.mjs`
- Test: `tests/metrics.test.mjs`

**Interfaces:**
- Consumes : un tableau `Ad[]` (post-`classifyAd`).
- Produces : `nullLongevityRate(ads) -> number`, `emptyHookRate(ads) -> number`, `countByOwner(ads) -> {atm: number, competitor: number}`, `countByMarket(ads) -> Record<market, number>`, `maxAdsForAnyBrand(ads) -> number`.

Scope volontairement limité au lot 1 : le catalogue complet de métriques §6 de la spec (survie à 30/60/90j, vecteurs émotionnels pondérés, n-grammes...) appartient au module de comparaison, lot 4. Ce lot ne construit que ce qu'exigent les garde-fous §9 et les critères d'acceptation §10.

- [ ] **Étape 1 : écrire les tests**

```javascript
// tests/metrics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nullLongevityRate, emptyHookRate, countByOwner, countByMarket, maxAdsForAnyBrand } from '../lib/metrics.mjs';

const ads = [
  { running_days: 0, hook: '', owner: 'competitor', market: 'fr', brand_id: 'a' },
  { running_days: 12, hook: 'x', owner: 'competitor', market: 'fr', brand_id: 'a' },
  { running_days: 40, hook: 'y', owner: 'atm', market: 'uk', brand_id: 'b' },
];

test('nullLongevityRate compte la part de running_days === 0', () => {
  assert.equal(nullLongevityRate(ads), 1 / 3);
});

test('nullLongevityRate vaut 0 sur tableau vide (jamais NaN)', () => {
  assert.equal(nullLongevityRate([]), 0);
});

test('emptyHookRate compte la part de hook vide', () => {
  assert.equal(emptyHookRate(ads), 1 / 3);
});

test('countByOwner ventile atm vs competitor', () => {
  assert.deepEqual(countByOwner(ads), { atm: 1, competitor: 2 });
});

test('countByMarket ventile par marché', () => {
  assert.deepEqual(countByMarket(ads), { fr: 2, uk: 1 });
});

test('maxAdsForAnyBrand renvoie le plus grand nombre de pubs pour une même marque', () => {
  assert.equal(maxAdsForAnyBrand(ads), 2); // brand_id 'a' a 2 pubs
});
```

- [ ] **Étape 2 : lancer les tests, vérifier l'échec**

```bash
node --test tests/metrics.test.mjs
```

- [ ] **Étape 3 : implémenter `lib/metrics.mjs`**

```javascript
// lib/metrics.mjs
// Statistiques déterministes sur un tableau d'Ad. Pur, testé, zéro I/O.
// Le LLM ne reçoit que le résultat de ces fonctions, jamais les pubs brutes à compter
// lui-même (SPEC-BENCHMARK-V2.md §6, règle absolue n°5 de CLAUDE.md).

export function nullLongevityRate(ads) {
  if (!ads.length) return 0;
  return ads.filter(a => a.running_days === 0).length / ads.length;
}

export function emptyHookRate(ads) {
  if (!ads.length) return 0;
  return ads.filter(a => !a.hook || !a.hook.trim()).length / ads.length;
}

export function countByOwner(ads) {
  return ads.reduce((acc, a) => {
    acc[a.owner] = (acc[a.owner] || 0) + 1;
    return acc;
  }, { atm: 0, competitor: 0 });
}

export function countByMarket(ads) {
  return ads.reduce((acc, a) => {
    acc[a.market] = (acc[a.market] || 0) + 1;
    return acc;
  }, {});
}

export function maxAdsForAnyBrand(ads) {
  const counts = ads.reduce((acc, a) => {
    acc[a.brand_id] = (acc[a.brand_id] || 0) + 1;
    return acc;
  }, {});
  return Math.max(0, ...Object.values(counts));
}
```

- [ ] **Étape 4 : lancer les tests, vérifier qu'ils passent**

```bash
node --test tests/metrics.test.mjs
```

- [ ] **Étape 5 : ajouter le script `test` dans `package.json` et commit**

```json
"scripts": {
  "benchmark:ugc": "node benchmark-ugc.mjs",
  "test": "node --test tests/"
}
```

```bash
git add lib/metrics.mjs tests/metrics.test.mjs package.json
git commit -m "Ajoute metrics.mjs et le script npm test (lot 1)"
```

- [ ] **Étape 6 : vérifier que la suite complète passe**

```bash
npm test
```

Attendu : tous les tests de `normalize.test.mjs`, `classify.test.mjs`, `metrics.test.mjs` passent (critère d'acceptation §10 : « npm test passe sur metrics.mjs »).

---

## Task 5 : `lib/foreplay-shared.mjs` — pagination 250 + curseur, correctifs bas niveau

**Files:**
- Modify: `lib/foreplay-shared.mjs`

**Interfaces:**
- Consumes : rien de nouveau (même `FOREPLAY_API_KEY`, même `FOREPLAY_BASE`).
- Produces : `getBrandAdsRaw(brandId, { maxAds }) -> rawAd[]` (nouveau, pagination par curseur, forme **brute** de l'API, destiné à `normalize.mjs`). `getBrandAds(brandId)` (existant, conservé **tel quel dans sa forme de sortie** — `{id, format, days_active, platforms, start_date, hook_text, img, url, live}` — pour que `run-report.mjs` continue de fonctionner sans modification de son propre code après l'import ; en interne, il est réécrit pour utiliser `getBrandAdsRaw` + `normalizeAd`, ce qui corrige de fait ses bugs `days_active`/`hook_text` sans toucher à une seule ligne de `run-report.mjs`).

Vérification faite dans cette session : `limit` sur `/api/spyder/brand/ads` n'a pas été confirmé à 250 par un appel réel (seul `/api/spyder/brands` a été testé, plafonné à 10). La spec l'affirme à 250 : le code doit gérer un éventuel rejet 422 en retombant sur une valeur plus basse, à l'image du correctif déjà appliqué sur `getSpyderBrands` dans cette session pour `limit`.

- [ ] **Étape 1 : modifier `lib/foreplay-shared.mjs`**

```javascript
// Ajouts en haut du fichier, après les imports existants :
import { normalizeAd } from './normalize.mjs';

const DEFAULT_MAX_ADS_PER_BRAND = parseInt(process.env.MAX_ADS_PER_BRAND || '250', 10);

// Remplace la fonction getBrandAds existante par :

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
```

Ce choix garde `getBrandAds` au plafond historique de 20 pubs/marque (au lieu de 250) : c'est la fonction utilisée par `run-report.mjs`, dont ce lot ne doit pas changer le comportement observable (fréquence, coût en crédits, structure du dashboard) au-delà de la correction des bugs de champs. Le passage à 250 pubs/marque avec le budget de crédits que ça implique est un choix pour `benchmark-ugc.mjs` uniquement (Task 7), qui appelle `getBrandAdsRaw` directement.

- [ ] **Étape 2 : vérifier qu'il n'y a pas de régression sur run-report.mjs (lecture, pas de run réel — coûte des crédits)**

```bash
node --check lib/foreplay-shared.mjs
node --check run-report.mjs
```

- [ ] **Étape 3 : commit**

```bash
git add lib/foreplay-shared.mjs
git commit -m "Pagination par curseur sur brand/ads, days_active et hook_text corrigés (lot 1)"
```

---

## Task 6 : `run-report.mjs` — dédupliquer sans réécrire

**Files:**
- Modify: `run-report.mjs`

**Interfaces:** aucune nouvelle interface — ce script garde exactement son comportement (prompt OpenAI, génération HTML, Slack), seule sa source de constantes/fonctions Foreplay change.

- [ ] **Étape 1 : supprimer la copie inline, ajouter l'import**

Dans `run-report.mjs`, remplacer le bloc allant de `const OWN_BRAND_KEYWORDS = ...` jusqu'à la fin de `getBrandAds` (la copie inline complète des constantes et fonctions Foreplay) par :

```javascript
import {
  OWN_BRAND_KEYWORDS, IRRELEVANT_KEYWORDS, COUNTRY_RULES,
  classifyCountry, isOwnBrand, isIrrelevant,
  foreplayGet, getSpyderBrands, getBrandAds,
} from './lib/foreplay-shared.mjs';
```

Ne rien changer d'autre dans le fichier : `fetchAllData`, `fetchMetaData`, `analyzeWithClaude`, `generateHTML`, `slackPost`, `postReportToSlack`, `buildIndexPage`, `main` restent identiques.

- [ ] **Étape 2 : vérifier la syntaxe et l'absence de référence orpheline**

```bash
node --check run-report.mjs
grep -n "OWN_BRAND_KEYWORDS\|IRRELEVANT_KEYWORDS\|COUNTRY_RULES\|classifyCountry\|isOwnBrand\|isIrrelevant\|foreplayGet\|getSpyderBrands\|getBrandAds" run-report.mjs
```

Attendu : chaque nom n'apparaît plus que dans l'import et dans son usage plus bas dans le fichier, aucune redéfinition locale restante.

- [ ] **Étape 3 : commit**

```bash
git add run-report.mjs
git commit -m "run-report.mjs importe lib/foreplay-shared.mjs au lieu d'une copie inline (lot 1)"
```

---

## Task 7 : `benchmark-ugc.mjs` — tag ATM, cascade de marché, garde-fous, `data/dataset-<date>.json`

**Files:**
- Modify: `benchmark-ugc.mjs`

**Interfaces:**
- Consumes : `getSpyderBrands` (inchangé), `getBrandAdsRaw` (Task 5), `normalizeAd` (Task 2), `classifyAd` (Task 3), `nullLongevityRate`/`emptyHookRate`/`maxAdsForAnyBrand` (Task 4), `config/atm-brands.json` (Task 1).
- Produces : `data/dataset-<date>.json` contenant `{ generatedAt, ads: Ad[] }` (tableau plat, non pré-regroupé — spec §4.3 : « les regroupements par marché ou par marque sont dérivés côté client, jamais figés dans le JSON »). Conserve en plus les sorties existantes (`data/benchmark-ugc-<date>.json`, `docs/benchmark-ugc-<date>.html`) : ce lot ne retire aucune fonctionnalité déjà livrée, il corrige les données qui l'alimentent.

**Changements de fond, dans l'ordre où ils touchent le fichier actuel :**

1. Supprimer `isOwnBrandExtended`, `EXTRA_OWN_BRAND_KEYWORDS` : remplacés par `config/atm-brands.json` + `classifyAd`. Les marques ATM ne sont plus filtrées, elles sont incluses avec `owner: 'atm'`.
2. `fetchBenchmarkData` devient : pour chaque marque Spyder (toutes, sans filtre `isOwnBrandExtended`/`isIrrelevant` en amont), `getBrandAdsRaw` puis `normalizeAd` + `classifyAd` par pub, via `Promise.allSettled` (pattern conservé). Le regroupement par marché pour le HTML existant se fait *après*, en dérivant depuis le tableau plat `ads` (pas de structure figée).
3. Les pubs `in_scope: false` restent dans le dataset JSON complet mais sont exclues du HTML actuel par marché (remplace l'ancien filtre `isIrrelevant` en amont) ; ajouter un compteur affiché dans chaque onglet Résumé : « N pubs hors périmètre masquées ».
4. Garde-fou de qualité avant toute écriture de fichier : si `nullLongevityRate(ads) > 0.2` ou `emptyHookRate(ads) > 0.3`, `throw` avec un message explicite citant les deux taux (§9 : "échec du run avec message explicite").
5. `topPerformers` par marché trie désormais sur `running_days` réel (plus sur `days_active` toujours nul) : `(b.live === true) - (a.live === true) || (b.running_days - a.running_days)`.
6. Le catalogue `ATM_CATALOG` de taglines UGC continue de s'appuyer sur la liste fixe des 11 produits (inchangé) : c'est une liste de concepts possibles pour les idées créatives, indépendante de `config/atm-brands.json` qui sert lui à taguer les pubs réellement observées.

- [ ] **Étape 1 : remplacer les imports et la détection ATM**

```javascript
import atmBrandsConfig from './config/atm-brands.json' with { type: 'json' };
import {
  getSpyderBrands, getBrandAdsRaw,
} from './lib/foreplay-shared.mjs';
import { normalizeAd } from './lib/normalize.mjs';
import { classifyAd } from './lib/classify.mjs';
import { nullLongevityRate, emptyHookRate } from './lib/metrics.mjs';
```

Supprimer : `import { getSpyderBrands, getBrandAds, classifyCountry, isOwnBrand, isIrrelevant } from './lib/foreplay-shared.mjs';`, `EXTRA_OWN_BRAND_KEYWORDS`, `isOwnBrandExtended`.

- [ ] **Étape 2 : réécrire `fetchBenchmarkData`**

```javascript
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
```

- [ ] **Étape 3 : ajouter le garde-fou de qualité et l'écriture de `data/dataset-<date>.json` dans `main()`**

```javascript
const ads = await fetchBenchmarkData();
if (ads.length === 0) throw new Error('Aucune donnée récupérée. Vérifie ta clé API Foreplay.');

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
console.log(`  → Dataset canonique sauvegardé : data/dataset-${today}.json (${ads.length} pubs, ${nullLongevityRate(ads) === 0 ? 'aucune' : (nullRate*100).toFixed(1)+'%'} longévités nulles)`);
```

Le reste de `main()` (regroupement par marché pour le HTML existant, appels `analyzeTrends`/`analyzeUGC`, écriture de `data/benchmark-ugc-<date>.json` et `docs/benchmark-ugc-<date>.html`) doit être adapté pour dériver le regroupement par marché depuis `ads` filtré sur `in_scope: true` plutôt que depuis l'ancienne structure `benchmark[market].brands`. Ce remaniement est mécanique (même forme de sortie HTML/JSON qu'aujourd'hui, source de données différente) : le confier à une passe d'implémentation avec `benchmark-ugc.mjs` ouvert à côté de ce plan, en gardant `renderBenchmark`/`renderResume`/`initCharts` (déjà en place) inchangés dans leur contrat d'entrée.

- [ ] **Étape 4 : lancer un run réel et vérifier les critères d'acceptation lot 1**

```bash
set -a; source .env; set +a
node benchmark-ugc.mjs
node -e "
const d = require('./data/dataset-$(date +%Y-%m-%d).json'.replace('require','import'));
" 2>/dev/null || node --input-type=module -e "
import fs from 'fs';
const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const withRunningDays = d.ads.filter(a => a.running_days > 0).length;
console.log('pubs avec running_days > 0 :', withRunningDays, '/', d.ads.length);
console.log('marques ATM taguées :', d.ads.filter(a => a.owner === 'atm').length);
console.log('unclassified :', d.ads.filter(a => a.market === 'unclassified').length);
console.log('global :', [...new Set(d.ads.filter(a => a.market === 'global').map(a=>a.brand_name))]);
" "data/dataset-$(date +%Y-%m-%d).json"
```

Vérifier à l'œil que la liste `global` affichée ne contient plus que des marques réellement mondiales (LEGO, UNO, Mattel...).

- [ ] **Étape 5 : commit**

```bash
git add benchmark-ugc.mjs
git commit -m "benchmark-ugc.mjs tague ATM au lieu de filtrer, cascade de marché, garde-fous qualité, dataset canonique (lot 1)"
```

---

## Self-Review (fait avant livraison du plan)

**Couverture spec :**
- §2.1 (days_active) → Task 2 (`running_days`) + Task 5 (`getBrandAdsRaw`/`getBrandAds`).
- §2.2 (hooks vides) → Task 2 (`resolveHook`).
- §2.3 (plafond 20 pubs) → Task 5 (`getBrandAdsRaw`, pagination curseur, 250).
- §2.4 (classification fausse, 10 erreurs) → Task 3 (`classifyMarket`), chaque erreur couverte par un test nommé.
- §2.5 (liste noire manuelle) → Task 3 (`classifyInScope`, niches/category en priorité).
- §2.6 (duplication run-report.mjs) → Task 6.
- §2.7 (ROAS inventé) → explicitement hors scope (Lot 6), non traité ici.
- §2.8 (clés exposées) → signalé à l'utilisateur hors plan (action humaine, pas du code).
- §4.3 (schéma Ad, owner ne filtre pas) → Task 2, Task 3, Task 7 étape 1-2.
- §9 Lot 1 (garde-fous qualité) → Task 7 étape 3.
- §10 critères d'acceptation → vérifiés explicitement à la Task 7 étape 4 et Task 4 étape 6 (`npm test`).
- §11.3 (Promise.allSettled, retry) → conservé en Task 7 ; le retry avec backoff exponentiel sur 429/5xx n'est **pas** couvert par ce plan (absent des bullets Lot 1 §9, présent seulement en §11.3 générale) : à ajouter en Task 5 si l'exécution réelle du run complet (Task 7 étape 4) rencontre des 429.

**Placeholders :** aucun trouvé après relecture ; chaque étape a du code réel ou une commande réelle.

**Cohérence des types :** `Ad` a le même jeu de champs entre `normalizeAd` (Task 2), `classifyAd` (Task 3) et les consommateurs (`metrics.mjs` Task 4, `benchmark-ugc.mjs` Task 7) — `owner`, `market`, `running_days`, `hook`, `brand_id`, `in_scope` utilisés à l'identique partout.

**Hors scope assumé (lots suivants, à ne pas anticiper ici) :** découpage fetch/build/analyze/render (lot 2), `data/history.json` (lot 2), dashboard filtrable avec état dans l'URL (lot 3), module de comparaison / radar émotionnel / heatmaps (lot 4), rankings/vélocité (lot 5), jointure Lens et ROAS Meta (lot 6), prompts LLM par marché avec validation d'`evidence` (lot 7).
