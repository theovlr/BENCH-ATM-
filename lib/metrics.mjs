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
