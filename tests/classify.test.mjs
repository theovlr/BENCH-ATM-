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

test('classifyInScope accepte "Party Game" (singulier), pas seulement "games" au pluriel', () => {
  const inScope = classifyInScope(
    { niches: [], product_category: 'Party Game' },
    { category: '', name: 'Olé Mains' }
  );
  assert.equal(inScope, true);
});
