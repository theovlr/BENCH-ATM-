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
