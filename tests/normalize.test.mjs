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

test('normalizeAd ne fabrique jamais de foreplay_url différente de celle fournie par l\'API', () => {
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
