/**
 * Ranking de ligas no frontend — espelha LEAGUE_PRIORITY do backend.
 * Rank menor = liga mais principal (Champions 0 ... resto 99, penalizadas +50).
 */

const RULES: Array<{ test: RegExp; exclude?: RegExp }> = [
  { test: /champions/i, exclude: /femen|women|mujer|youth|u ?19|juvenil/i },
  { test: /europa league/i, exclude: /femen|women|mujer|conference/i },
  {
    test: /premier league/i,
    exclude: /del norte|northern|del sur|southern|copa|internacional|u ?21|sub ?21|s21|femen|feminin|women|mujer| de |del |kenya|kenia|bhutan|but[aã]o|mongol|nigeria|ghana|jamaica|burundi|shillong|estonia|irlanda|ireland|wales|gales|scotland|escocia/i,
  },
  { test: /la liga|laliga/i, exclude: /copa de la liga/i },
  { test: /spanish.*(rfef|federaci)|primera federaci/i },
  { test: /serie a/i, exclude: /serie [bcd]|femen|feminin|women|mujer/i },
  { test: /bundesliga/i, exclude: /femen|feminin|women|mujer| ii\b| 2\b/i },
  { test: /ligue 1/i, exclude: /femen|feminin|women|mujer/i },
  {
    test: /brasileir|liga portugal|primeira liga|conference/i,
    exclude: /femen|feminin|women|mujer|sub ?2\d|u ?2\d|juvenil/i,
  },
];

const PENALTY =
  /femenin|feminin|women|\(w\)|mujeres|ladies|u1\d|u2\d|juvenil|sub-?20|hong kong|mongol|nigeria|ghana|jamaica|gales|escocia|bielorru|burundi|panam|bhutan|nadeshiko|nepal/i;

export function leagueRank(league?: string | null): number {
  const s = league || '';
  const idx = RULES.findIndex((r) => r.test.test(s) && !(r.exclude && r.exclude.test(s)));
  const rank = idx === -1 ? 99 : idx;
  if (rank < 99 && PENALTY.test(s)) return rank + 50;
  return rank;
}

export function isTopTierLeague(league?: string | null): boolean {
  return leagueRank(league) < 8;
}
