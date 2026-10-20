/**
 * Ranking de ligas no frontend — espelha LEAGUE_PRIORITY do backend.
 * Rank menor = liga mais principal (Champions 0 ... resto 99, penalizadas +50,
 * divisões inferiores 120).
 */

/** IDs oficiais do AiScore — espelha MAIN_COMPETITION_IDS do backend. */
const ID_RANK = new Map<string, number>([
  ['xo17pji02i37jw5', 0], // UEFA Champions League
  ['2jr7owi6es1q0em', 1], // UEFA Europa League
  ['mo07dni2vfxknxy', 2], // English Premier League
  ['yzrkn6iorbjqle4', 3], // Spanish La Liga
  ['r8lk2di1xb0736d', 4], // Italian Serie A
  ['1edq09ignayqxgo', 5], // Bundesliga
  ['5xvkjoilecr7938', 6], // Ligue 1
  ['n527r3ipms17evx', 7], // Portuguese Primeira Liga
  ['r8lk2dil5t0736d', 7], // Brazilian Serie A
  ['zjek33ien6ivko2', 7], // UEFA Conference League
]);

const LOWER_ID = new Set([
  '8vrqwnin9sjqn2o', // English Championship
  'w34kgmixet1ko92', // 2. Bundesliga
  'g63kv9i9gcz7ezv', // Italian Serie B
  '9oj7x9i9rhe7g3y', // Spanish La Liga 2
  '0m2q15i5obp76xw', // French Ligue 2
  '5wv78xin5hjkrjn', // Liga Portugal 2
  '59gklzinwwa37xd', // Liga 3 portuguesa
]);

const RULES: Array<{ test: RegExp; exclude?: RegExp }> = [
  { test: /champions|liga de campeones|liga dos campeoes/i, exclude: /femen|women|mujer|youth|u ?19|juvenil/i },
  { test: /europa league|liga europa/i, exclude: /femen|women|mujer|conference|conferencia/i },
  {
    test: /premier league|liga premier de inglaterra|premier league inglesa/i,
    exclude: /del norte|northern|del sur|southern|copa|internacional|u ?21|sub ?21|s21|femen|feminin|women|mujer|kenya|kenia|bhutan|but[aã]o|mongol|nigeria|ghana|jamaica|burundi|shillong|estonia|irlanda|ireland|wales|gales|scotland|escocia|egip|siria|iraq|catar|qatar|libia|argelia|tunez|jordania|kuwait|bahrein|barein|oman|oma|libano|yemen|sudan|etiopia|uganda|tanzania|zambia|malaui|botsuana|sierra|gana|senegal|mali|niger|burkina|benin|togo|guine|maurit|ruanda|burundi|angola|mozambique|zimbabue|camboja|vietnam|indonesia|filipinas|singapur|malasia|myanmar|tailandia|laos|mongolia|nepal|butao|maldivas|sri lanka|bangladesh|india|paquistao|tajiquistao|turcomenistao|uzbequistao|quirguistao|cazaquistao|armenia|azerbaijao|georgia|moldavia|estonia|letonia|lituania|finlandia|islandia|noruega|suecia|dinamarca|belgica|holanda|austria|suica|polonia|chequia|eslovaquia|hungria|romenia|bulgaria|servia|croacia|eslovenia|bosnia|macedonia|albania|grecia|turquia|chipre|malta|luxemburgo|andorra|gibraltar|ilhas feroe|kosovo|montenegro/i,
  },
  { test: /la liga|laliga/i, exclude: /copa de la liga/i },
  { test: /serie a/i, exclude: /serie [bcd]|femen|feminin|women|mujer/i },
  { test: /bundesliga/i, exclude: /femen|feminin|women|mujer| ii\b| 2\b/i },
  { test: /ligue 1/i, exclude: /femen|feminin|women|mujer/i },
  {
    test: /brasileir|liga portugal|liga primera de portugal|primeira liga|conference|conferencia/i,
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

export function leagueRank(league?: string | null, competitionId?: string | null): number {
  const s = league || '';
  const cid = (competitionId || '').trim();
  if (cid) {
    const byId = ID_RANK.get(cid);
    if (byId !== undefined) return byId;
    if (LOWER_ID.has(cid)) return 120;
    return 99;
  }
  if (isLowerDivisionLeague(s)) return 120;
  const idx = RULES.findIndex((r) => r.test.test(s) && !(r.exclude && r.exclude.test(s)));
  const rank = idx === -1 ? 99 : idx;
  if (rank < 99 && PENALTY.test(s)) return rank + 50;
  return rank;
}

export function isTopTierLeague(league?: string | null, competitionId?: string | null): boolean {
  return leagueRank(league, competitionId) < 8;
}
