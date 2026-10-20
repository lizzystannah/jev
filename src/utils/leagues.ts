/**
 * Ranking de ligas no frontend — espelha LEAGUE_PRIORITY do backend.
 * Rank menor = liga mais principal (Champions 0 ... resto 99, penalizadas +50,
 * divisões inferiores 120).
 */

const RULES: Array<{ test: RegExp; exclude?: RegExp }> = [
  { test: /champions/i, exclude: /femen|women|mujer|youth|u ?19|juvenil/i },
  { test: /europa league/i, exclude: /femen|women|mujer|conference/i },
  {
    test: /premier league/i,
    exclude: /del norte|northern|del sur|southern|copa|internacional|u ?21|sub ?21|s21|femen|feminin|women|mujer| de |del |kenya|kenia|bhutan|but[aã]o|mongol|nigeria|ghana|jamaica|burundi|shillong|estonia|irlanda|ireland|wales|gales|scotland|escocia/i,
  },
  { test: /la liga|laliga/i, exclude: /copa de la liga/i },
  { test: /serie a/i, exclude: /serie [bcd]|femen|feminin|women|mujer/i },
  { test: /bundesliga/i, exclude: /femen|feminin|women|mujer| ii\b| 2\b/i },
  { test: /ligue 1/i, exclude: /femen|feminin|women|mujer/i },
  {
    test: /brasileir|liga portugal|primeira liga|conference/i,
    exclude: /femen|feminin|women|mujer|sub ?2\d|u ?2\d|juvenil/i,
  },
];

const PENALTY =
  /femenin|feminin|women|\(w\)|mujeres|ladies|reserva|reserve|reserves|reservas|filial|filiais|u1\d|u2\d|juvenil|sub-?2\d|hong kong|mongol|nigeria|ghana|jamaica|gales|escocia|bielorru|burundi|panam|bhutan|nadeshiko|nepal/i;

/** Segunda/terceira divisão — espelha LOWER_DIVISION do backend. */
const LOWER_DIVISION =
  /\bserie\s*[b-d]\b|\b(segunda|segundo|intermedia|reserva|reservas|reserve|reserves|filial|filiais)\b|\b(2|ii|2a)\s*\.?\s*(divis|division|divisao|divisione|liga|bundesliga|league)\b|\b(bundesliga|ligue|la ?liga|laliga|league|liga|divisie|division|divisao)\s*(2|ii|3|iii)\b|\b(championship|league one|league two|national league|regionalliga|oberliga|landesliga|verbandsliga|superettan|challenger pro league|eerste divisie|tweede divisie|keuken kampioen|hypermotion|campeonato de portugal|liga portugal 2|primera b|primera c|primera nacional|primera federacion|segunda federacion|tercera federacion|tercera division|tff 1\.\s*lig|1\.\s*lig|liga ii|liga 2|liga 3|division 2|division 3|divisao 2|divisao 3|divisie 2|divisie 3)\b/;

function normalizeLeague(league?: string | null): string {
  return (league || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function isLowerDivisionLeague(league?: string | null): boolean {
  return LOWER_DIVISION.test(normalizeLeague(league));
}

export function leagueRank(league?: string | null): number {
  const s = league || '';
  if (isLowerDivisionLeague(s)) return 120;
  const idx = RULES.findIndex((r) => r.test.test(s) && !(r.exclude && r.exclude.test(s)));
  const rank = idx === -1 ? 99 : idx;
  if (rank < 99 && PENALTY.test(s)) return rank + 50;
  return rank;
}

export function isTopTierLeague(league?: string | null): boolean {
  return leagueRank(league) < 8;
}
