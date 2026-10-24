import fs from 'fs';
import path from 'path';
import { MatchItem, MatchOdds, MarketType, MarketProviderStatus } from './types.js';
import {
  aiscoreClient,
  aiscoreYmd,
  aiscoreDateKey,
  parseKickoffMs,
} from './aiscoreService.js';

/** Ligas principais primeiro na ingestão/seleção (peso espelha ticketEngine). */
export const LEAGUE_PRIORITY: Array<{ test: RegExp; exclude?: RegExp; label: string }> = [
  { test: /champions|liga de campeones|liga dos campeoes/i, exclude: /femen|women|mujer|youth|u ?19|juvenil/i, label: 'Champions League' },
  { test: /europa league|liga europa/i, exclude: /femen|women|mujer|conference|conferencia/i, label: 'Europa League' },
  // "Premier League del Norte", U21, Butão, etc. NÃO são a Premier League inglesa.
  {
    test: /premier league|liga premier de inglaterra|premier league inglesa/i,
    exclude: /del norte|northern|del sur|southern|copa|internacional|u ?21|sub ?21|s21|femen|feminin|women|mujer|kenya|kenia|bhutan|but[aã]o|mongol|nigeria|ghana|jamaica|burundi|shillong|mizoram|goa|kerala|calcutt|estonia|irlanda|ireland|wales|gales|scotland|escocia|egip|siria|iraq|catar|qatar|libia|argelia|tunez|jordania|kuwait|bahrein|barein|oman|libano|yemen|sudan|etiopia|uganda|tanzania|zambia|malaui|botsuana|sierra|gana|senegal|mali|niger|burkina|benin|togo|guine|maurit|ruanda|angola|mozambique|zimbabue|camboja|vietnam|indonesia|filipinas|singapur|malasia|myanmar|tailandia|laos|mongolia|nepal|butao|maldivas|sri lanka|bangladesh|india|paquistao|tajiquistao|turcomenistao|uzbequistao|quirguistao|cazaquistao|armenia|azerbaijao|georgia|moldavia|letonia|lituania|finlandia|islandia|noruega|suecia|dinamarca|belgica|holanda|austria|suica|polonia|chequia|eslovaquia|hungria|romenia|bulgaria|servia|croacia|eslovenia|bosnia|macedonia|albania|grecia|turquia|chipre|malta|luxemburgo|andorra|gibraltar|feroe|kosovo|montenegro/i,
    label: 'Premier League',
  },
  // "Copa de la Liga" (Peru/Bolívia/Catar) não é a La Liga espanhola.
  { test: /la liga|laliga/i, exclude: /copa de la liga/i, label: 'La Liga' },
  { test: /serie a/i, exclude: /serie [bcd]|femen|feminin|women|mujer/i, label: 'Serie A' },
  { test: /bundesliga/i, exclude: /femen|feminin|women|mujer| ii\b| 2\b/i, label: 'Bundesliga' },
  { test: /ligue 1/i, exclude: /femen|feminin|women|mujer/i, label: 'Ligue 1' },
  {
    test: /brasileir|liga portugal|liga primera de portugal|primeira liga|conference league|liga confer[eê]ncia|confer[eê]ncia europa|j1 league|j1 de jap[oó]n|s[uü]per lig|liga profesional saud[ií]|saudi pro league|super ?liga s[eé]rvia|serbian mozzart bet superliga|srbij/i,
    exclude: /femen|feminin|women|mujer|sub ?2\d|u ?2\d|juvenil|j[2-4]|english conference|confer[eê]ncia inglesa|conference (north|south)|confer[eê]ncia (norte|sur)|liga de f[uú]tbol japonesa|divisi[oó]n (1|2)|saudi (first|second) division|prva liga/i,
    label: 'Outras top',
  },
];

/**
 * IDs oficiais do AiScore das competições que podem entrar em bilhetes.
 * O nome localizado varia ("Premier League", "Liga Premier de Inglaterra",
 * "Premier League egipcia"...) e não distingue Catar/Egito/Síria de Inglaterra;
 * o ID distingue. Fonte: football/comp/map + day_card.
 */
export const MAIN_COMPETITION_IDS: Map<string, number> = new Map([
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
  ['4ndqmliwou5kveg', 7], // Turkish Super Lig
  ['eg6763ig9s47ryv', 7], // J1 League (Japan)
  ['g63kv9imm6iz7ez', 7], // Saudi Pro League
  ['5xvkjoi25sr7938', 7], // Serbian Mozzart Bet Superliga (Estrela Vermelha)
  ['yzrkn6i2rcjqle4', 8], // Netherlands Eredivisie
]);

/** IDs de divisões inferiores conhecidas (nunca entram em bilhetes). */
export const LOWER_COMPETITION_IDS: Set<string> = new Set([
  '8vrqwnin9sjqn2o', // English Championship
  'w34kgmixet1ko92', // 2. Bundesliga
  'g63kv9i9gcz7ezv', // Italian Serie B
  '9oj7x9i9rhe7g3y', // Spanish La Liga 2
  '0m2q15i5obp76xw', // French Ligue 2
  '5wv78xin5hjkrjn', // Liga Portugal 2
  '59gklzinwwa37xd', // Liga 3 portuguesa
  '2ezk96i4zs2kn51', // J2 League (Japan)
  'el6kegilncn75dp', // Japan Football League (J3/J4)
  'el6kegie0an75dp', // English Conference North
  '2ezk96i5wc2kn51', // English Conference South
  'zjek33i66pivko2', // Saudi First Division
  'mo07dnidd8ixknx', // Saudi Second Division
  '8vrqwnioo5ujqn2', // Saudi Youth League
]);

/** Penaliza feminino/base/obscuro — espelha _COMP_PENALTY_KEYS do bridge. */
const LEAGUE_PENALTY = /femenin|feminin|women|\(w\)|mujeres|ladies|reserva|reserve|reserves|reservas|filial|filiais|u1\d|u2\d|juvenil|sub-?2\d|hong kong|mongol|nigeria|ghana|jamaica|gales|escocia|bielorru|burundi|panam|bhutan|nadeshiko|nepal|mizoram|goa|kerala|calcutt|tanzania|uganda|kenya|zambia/i;

/** Liga obscura (feminino/base/exótica): excluída dos bilhetes. */
export function isObscureLeague(league?: string | null): boolean {
  return LEAGUE_PENALTY.test(league || '');
}

/** Ligas femininas — excluídas dos bilhetes por completo. */
const WOMENS_LEAGUE = /femenin|feminin|women|\(w\)|mujeres|ladies|woman|female/i;
export function isWomensLeague(league?: string | null): boolean {
  return WOMENS_LEAGUE.test(league || '');
}

function normalizeLeague(league?: string | null): string {
  return (league || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Segunda/terceira divisão (e ligas de acesso): NUNCA entram em bilhetes.
 * Cobre Serie B/C/D, Segunda División, 2. Bundesliga, Ligue 2, Championship,
 * LaLiga Hypermotion, Primera Federación, Liga 3, Regionalliga, etc.
 */
const LOWER_DIVISION =
  /\bserie\s*[b-d]\b|\b(segunda|segundo|intermedia|reserva|reservas|reserve|reserves|filial|filiais)\b|\b(2|ii|2a)\s*\.?\s*(divis|division|divisao|divisione|liga|bundesliga|league)\b|\b(bundesliga|ligue|la ?liga|laliga|league|liga|divisie|division|divisao)\s*(2|ii|3|iii)\b|\b(championship|league one|league two|national league|regionalliga|oberliga|landesliga|verbandsliga|superettan|challenger pro league|eerste divisie|tweede divisie|keuken kampioen|hypermotion|campeonato de portugal|liga portugal 2|primera b|primera c|primera nacional|primera federacion|segunda federacion|tercera federacion|tercera division|tff 1\.\s*lig|1\.\s*lig|liga ii|liga 2|liga 3|division 2|division 3|divisao 2|divisao 3|divisie 2|divisie 3)\b|\bj[2-4]\b|\bliga de futbol japonesa\b|\b(conference|conferencia)\s*(north|south|norte|sur|inglesa|english)\b|\b(arabia saudita|saudi)\s*(division|first|second)\s*(1|2)?\b/;

export function isLowerDivisionLeague(league?: string | null): boolean {
  return LOWER_DIVISION.test(normalizeLeague(league));
}

/**
 * Liga principal para fins de bilhete: masculina, não exótica e não divisão inferior.
 * Com `competitionId` (AiScore), só a whitelist oficial conta — é o que impede
 * "Premier League egipcia/siria/iraquí" e a "Premier League" do Catar.
 */
export function isMainLeague(league?: string | null, competitionId?: string | null): boolean {
  if (isWomensLeague(league) || isObscureLeague(league) || isLowerDivisionLeague(league)) {
    return false;
  }
  const cid = (competitionId || '').trim();
  if (cid) return MAIN_COMPETITION_IDS.has(cid);
  return leaguePriorityRank(league) < 99;
}

export function leaguePriorityRank(league?: string | null, competitionId?: string | null): number {
  const s = league || '';
  const cid = (competitionId || '').trim();
  if (cid) {
    const byId = MAIN_COMPETITION_IDS.get(cid);
    if (byId !== undefined) return byId;
    if (LOWER_COMPETITION_IDS.has(cid)) return 120;
    // Competição desconhecida no feed: não confiar no nome localizado.
    return 99;
  }
  // Divisões inferiores ficam depois de qualquer liga principal/desconhecida.
  if (isLowerDivisionLeague(s)) return 120;
  const idx = LEAGUE_PRIORITY.findIndex((l) => l.test.test(s) && !(l.exclude && l.exclude.test(s)));
  const rank = idx === -1 ? 99 : idx;
  if (rank < 99 && LEAGUE_PENALTY.test(s)) return rank + 50;
  return rank;
}

/** Assinatura estável das odds/mercados reais (reutilização da calibração). */
export function oddsSignature(odds: MatchOdds): string {
  const rm = [...(odds.realMarkets || [])].sort().join(',');
  const parts: Array<string | number | null | undefined> = [
    odds.home, odds.draw, odds.away, odds.over25, odds.under25,
    odds.btts_yes, odds.btts_no, odds.over15, odds.over35, odds.under35,
    odds.double_chance_1x, odds.double_chance_x2, odds.double_chance_12,
    odds.dnb_home, odds.dnb_away, rm,
  ];
  return parts.map((v) => (v == null ? '' : String(v))).join('|');
}

function impliedProb(odd: number): number {
  return (1 / odd) * 100;
}

export const MARKET_LABELS: Record<MarketType, (ctx: { home: string; away: string }) => string> = {
  home: ({ home }) => `Vitória ${home} (1)`,
  draw: () => 'Empate (X)',
  away: ({ away }) => `Vitória ${away} (2)`,
  double_chance_1x: ({ home }) => `${home} ou Empate (1X)`,
  double_chance_x2: ({ away }) => `Empate ou ${away} (X2)`,
  double_chance_12: () => 'Qualquer equipa vence (12)',
  over15: () => 'Mais de 1.5 golos (+1.5G)',
  over25: () => 'Mais de 2.5 golos (+2.5G)',
  over35: () => 'Mais de 3.5 golos (+3.5G)',
  under25: () => 'Menos de 2.5 golos (-2.5G)',
  under35: () => 'Menos de 3.5 golos (-3.5G)',
  btts_yes: () => 'Ambas marcam — Sim (BTTS)',
  btts_no: () => 'Ambas marcam — Não',
  dnb_home: ({ home }) => `Empate Anula: ${home}`,
  dnb_away: ({ away }) => `Empate Anula: ${away}`,
};

export function deriveCompleteOdds(odds: MatchOdds): Record<MarketType, number> {
  const pHome = (1 / odds.home) * 100;
  const pDraw = (1 / odds.draw) * 100;
  const pAway = (1 / odds.away) * 100;
  const pOver25 = (1 / odds.over25) * 100;
  const pUnder25 = (1 / odds.under25) * 100;

  const p1X = pHome + pDraw * 0.55;
  const pX2 = pAway + pDraw * 0.55;
  const p12 = pHome + pAway * 0.9;
  const pOver15 = pOver25 * 1.35;
  const pOver35 = pOver25 * 0.60;
  const pUnder35 = pUnder25 * 1.30;

  // Preço real fornecido (ex.: odds da Premier Bet injetadas para um mercado
  // que o feed não cobre) tem prioridade sobre o valor derivado.
  const realOr = (provided: number | undefined, derived: number, lo: number, hi: number): number => {
    if (Number.isFinite(provided) && (provided as number) > 1.01) {
      return Number((provided as number).toFixed(2));
    }
    return Number(Math.max(lo, Math.min(hi, derived)).toFixed(2));
  };

  return {
    home: odds.home,
    draw: odds.draw,
    away: odds.away,
    double_chance_1x: realOr(odds.double_chance_1x, 1 / (p1X / 100) * 1.05, 1.05, 1.85),
    double_chance_x2: realOr(odds.double_chance_x2, 1 / (pX2 / 100) * 1.05, 1.05, 1.85),
    double_chance_12: realOr(odds.double_chance_12, 1 / (p12 / 100) * 1.05, 1.05, 1.50),
    over15: realOr(odds.over15, 1 / (Math.min(90, pOver15) / 100) * 1.05, 1.10, 1.65),
    over25: odds.over25,
    over35: realOr(odds.over35, 1 / (Math.min(90, pOver35) / 100) * 1.05, 1.60, 4.50),
    under25: odds.under25,
    under35: realOr(odds.under35, 1 / (Math.min(90, pUnder35) / 100) * 1.05, 1.10, 1.65),
    btts_yes: odds.btts_yes,
    btts_no: odds.btts_no,
    dnb_home: realOr(odds.dnb_home, odds.home * 0.72, 1.15, 3.50),
    dnb_away: realOr(odds.dnb_away, odds.away * 0.72, 1.15, 3.50),
  };
}

export function scoreMatch(match: Omit<MatchItem, 'tip' | 'status' | 'result'>): {
  market: MarketType;
  label: string;
  odds: number;
  prob: number;
  reason: string;
} {
  const { odds, home, away } = match;
  const pHome = impliedProb(odds.home);
  const pDraw = impliedProb(odds.draw);
  const pAway = impliedProb(odds.away);
  const pOver = impliedProb(odds.over25);
  const pUnder = impliedProb(odds.under25);
  const pBtts = impliedProb(odds.btts_yes);

  const candidates: { market: MarketType; prob: number; odds: number; reason: string }[] = [];
  // Só mercados com odds reais entram na dica. Sem `realMarkets` (dados
  // antigos) assume-se apenas 1X2: nunca usar um preço sem proveniência.
  const realMarkets = odds.realMarkets;
  const allows = (market: MarketType): boolean =>
    realMarkets
      ? realMarkets.includes(market)
      : market === 'home' || market === 'draw' || market === 'away';

  // 1X2 real
  if (allows('home')) {
    candidates.push({
      market: 'home',
      prob: Math.round(pHome),
      odds: odds.home,
      reason: `Superioridade evidente do ${home} no confronto direto.`,
    });
  }
  if (allows('draw')) {
    candidates.push({
      market: 'draw',
      prob: Math.round(pDraw),
      odds: odds.draw,
      reason: `Equilíbrio no confronto direto favorece o empate.`,
    });
  }
  if (allows('away')) {
    candidates.push({
      market: 'away',
      prob: Math.round(pAway),
      odds: odds.away,
      reason: `Excelente fase de ${away} conferindo vantagem de mercado.`,
    });
  }

  // Dupla Chance 1X (mercado derivado: só quando não há restrição de odds reais)
  if (allows('double_chance_1x')) {
    const p1X = pHome + pDraw * 0.55;
    const odds1X = Number(Math.max(1.10, Math.min(1.80, 1 / (p1X / 100) * 1.05)).toFixed(2));
    candidates.push({
      market: 'double_chance_1x',
      prob: Math.min(88, Math.round(p1X)),
      odds: odds1X,
      reason: `Forte favoritismo do ${home} em casa com cobertura de empate.`,
    });
  }

  // Dupla Chance X2 (mercado derivado)
  if (allows('double_chance_x2')) {
    const pX2 = pAway + pDraw * 0.55;
    const oddsX2 = Number(Math.max(1.10, Math.min(1.85, 1 / (pX2 / 100) * 1.05)).toFixed(2));
    candidates.push({
      market: 'double_chance_x2',
      prob: Math.min(85, Math.round(pX2)),
      odds: oddsX2,
      reason: `Boa consistência de ${away} fora com segurança em caso de empate.`,
    });
  }

  // +1.5 Golos (derivado)
  if (allows('over15')) {
    const pOver15 = pOver * 1.35;
    const oddsOver15 = Number(Math.max(1.12, Math.min(1.65, 1 / (Math.min(85, pOver15) / 100) * 1.05)).toFixed(2));
    candidates.push({
      market: 'over15',
      prob: Math.min(85, Math.round(pOver15)),
      odds: oddsOver15,
      reason: `Expectativa alta de golos com linha protegida de mais de 1.5.`,
    });
  }

  // -3.5 Golos (derivado)
  if (allows('under35')) {
    const pUnder35 = pUnder * 1.30;
    const oddsUnder35 = Number(Math.max(1.12, Math.min(1.60, 1 / (Math.min(85, pUnder35) / 100) * 1.05)).toFixed(2));
    candidates.push({
      market: 'under35',
      prob: Math.min(85, Math.round(pUnder35)),
      odds: oddsUnder35,
      reason: `Jogo de perfil tático com cobertura elástica de menos de 3.5 golos.`,
    });
  }

  if (allows('over25')) {
    candidates.push({
      market: 'over25',
      prob: Math.min(85, Math.round(pOver)),
      odds: odds.over25,
      reason: `Mercado de golos com preço real acima de 2.5.`,
    });
  }

  if (allows('under25')) {
    candidates.push({
      market: 'under25',
      prob: Math.min(85, Math.round(pUnder)),
      odds: odds.under25,
      reason: `Mercado de golos com preço real abaixo de 2.5.`,
    });
  }

  // BTTS (só com odd real)
  if (allows('btts_yes') && pBtts > 48) {
    candidates.push({
      market: 'btts_yes',
      prob: Math.min(75, Math.round(pBtts)),
      odds: odds.btts_yes,
      reason: `Ambas as equipas apresentam padrão ofensivo regular e odds competitivas.`,
    });
  }

  if (candidates.length === 0) {
    // Dados antigos sem realMarkets válidos: usa o favorito 1X2.
    candidates.push({
      market: 'home',
      prob: Math.round(pHome),
      odds: odds.home,
      reason: `Favoritismo do ${home} segundo o mercado.`,
    });
  }

  // Ordena por maior pontuação de segurança
  candidates.sort((a, b) => {
    const scoreA = a.prob * (a.odds >= 1.20 && a.odds <= 1.85 ? 1.2 : 0.9);
    const scoreB = b.prob * (b.odds >= 1.20 && b.odds <= 1.85 ? 1.2 : 0.9);
    return scoreB - scoreA;
  });

  const best = candidates[0];
  const labelFn = MARKET_LABELS[best.market];
  const label = labelFn ? labelFn({ home, away }) : best.market;

  return {
    market: best.market,
    label,
    odds: best.odds,
    prob: best.prob,
    reason: best.reason,
  };
}

export function getCalendarDayDiff(targetMs: number, timezone = 'Africa/Luanda'): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const nowDateStr = formatter.format(new Date());
    const targetDateStr = formatter.format(new Date(targetMs));

    const d1 = new Date(`${nowDateStr}T00:00:00Z`).getTime();
    const d2 = new Date(`${targetDateStr}T00:00:00Z`).getTime();

    return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  } catch (e) {
    const diffMs = targetMs - Date.now();
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  }
}

  const CACHE_FILE_PATH = path.join(process.cwd(), '.data', 'odds_api_cache.json');

interface PersistedCache {
  lastFetchTime: number;
  rateLimitInfo?: {
    requestsRemaining?: number;
    requestsUsed?: number;
  };
  matches: MatchItem[];
}

export class MarketService {
  private matches: MatchItem[] = [];
  private lastFetchTime = 0;
  private lastCacheSaveAt = 0;
  private activeFetchPromise: Promise<void> | null = null;
  private activeAiscorePromise: Promise<void> | null = null;
  private aiscoreLastSync = 0;
  /** Callbacks chamados quando o backfill +1..+8 termina (o scheduler repõe quotas). */
  private backfillCallbacks: Array<() => void> = [];
  private readonly AISCORE_TTL_MS = 15 * 60 * 1000;
  private providerStatus: MarketProviderStatus = {
    provider: 'the-odds-api',
    isExternalApi: true,
    apiKeyConfigured: false,
    providerName: 'The Odds API (Dados Reais ao Vivo)',
    lastUpdated: new Date().toISOString(),
    totalMatches: 0,
    activeLeagues: [],
    message: 'A inicializar sincronização com API de dados desportivos reais...',
  };

  constructor() {
    this.restoreDiskCache();
  }

  private restoreDiskCache(): void {
    try {
      if (fs.existsSync(CACHE_FILE_PATH)) {
        const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf-8');
        const data: PersistedCache = JSON.parse(raw);
        if (data && Array.isArray(data.matches)) {
          const now = Date.now();
          // Só restaura partidas futuras da API real (Odds API ou AiScore).
          const validMatches = data.matches.filter(
            (m) =>
              (m.sourceProvider === 'the-odds-api' || m.sourceProvider === 'aiscore') &&
              m.kickoffAt > now - 2 * 60 * 60 * 1000
          );
          if (validMatches.length > 0) {
            // Frescura pelo mtime do ficheiro: o lastFetchTime só é atualizado
            // pelo caminho da The Odds API, mas o cache também guarda AiScore.
            const ageMs = now - fs.statSync(CACHE_FILE_PATH).mtimeMs;
            if (ageMs < 6 * 60 * 60 * 1000) {
              this.matches = validMatches;
              this.lastFetchTime = data.lastFetchTime;
              this.lastCacheSaveAt = Date.now();
              if (data.rateLimitInfo) {
                this.providerStatus.rateLimitInfo = data.rateLimitInfo;
              }
              const calibrated = validMatches.filter((m) => m.calibration).length;
              console.log(
                `[MarketService] Cache restaurado: ${this.matches.length} jogos` +
                  (calibrated > 0 ? ` (${calibrated} com calibração persistida)` : '') +
                  '.'
              );
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('[MarketService] Cache em disco ignorado:', e?.message);
    }
  }

  private saveDiskCache(): void {
    try {
      // Guarda também o horizonte do AiScore: sem isto, cada restart começava
      // com ~80 jogos e o longo prazo ficava vazio até o backfill terminar.
      const realMatchesOnly = this.matches.filter(
        (m) => m.sourceProvider === 'the-odds-api' || m.sourceProvider === 'aiscore'
      );
      const data: PersistedCache = {
        lastFetchTime: this.lastFetchTime,
        rateLimitInfo: this.providerStatus.rateLimitInfo,
        matches: realMatchesOnly,
      };
      fs.mkdirSync(path.dirname(CACHE_FILE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
      this.lastCacheSaveAt = Date.now();
    } catch (e: any) {
      console.warn('[MarketService] Erro ao gravar cache em disco:', e?.message);
    }
  }

  /** Grava o cache (jogos + calibração) com um intervalo mínimo entre writes. */
  public saveCacheSoon(minGapMs = 5 * 60 * 1000): void {
    if (Date.now() - this.lastCacheSaveAt < minGapMs) return;
    this.saveDiskCache();
  }

  public getProviderStatus(): MarketProviderStatus {
    const oddsKey = process.env.ODDS_API_KEY?.trim();
    const fbKey = process.env.FOOTBALL_DATA_API_KEY?.trim();

    let provider: MarketProviderStatus['provider'] = 'the-odds-api';
    let providerName = 'The Odds API (Dados Reais ao Vivo)';
    let isExternalApi = true;
    let apiKeyConfigured = Boolean(oddsKey && oddsKey.length > 5);
    let message = 'Sincronização 100% em tempo real com dados de mercado reais.';

    if (oddsKey && oddsKey !== 'sua_chave_the_odds_api_aqui' && oddsKey.length > 5) {
      const remaining = this.providerStatus.rateLimitInfo?.requestsRemaining;
      message = remaining !== undefined
        ? `API Real ativa (Quota restante: ${remaining} requisições). Dados 100% oficiais de mercado.`
        : 'Chave ODDS_API_KEY ativa no servidor. Apenas dados reais da API são exibidos.';
    } else if (fbKey && fbKey.length > 5) {
      provider = 'football-data';
      providerName = 'Football-Data.org';
      apiKeyConfigured = true;
      message = 'Chave FOOTBALL_DATA_API_KEY ativa no servidor.';
    } else {
      apiKeyConfigured = Boolean(this.aiscoreLastSync > 0);
      if (apiKeyConfigured) {
        provider = 'aiscore';
        providerName = 'AiScore API (day card + odds 1X2)';
        message = `Fonte AiScore ativa (${this.matches.length} jogos). Lista do dia via bridge Python.`;
      } else {
        message = 'Nenhuma chave de dados desportivos configurada. Defina ODDS_API_KEY ou aguarde o sync AiScore.';
      }
    }

    const leagues = Array.from(new Set(this.matches.map((m) => m.league)));

    this.providerStatus = {
      ...this.providerStatus,
      provider,
      providerName,
      isExternalApi,
      apiKeyConfigured,
      message,
      totalMatches: this.matches.length,
      activeLeagues: leagues,
      lastUpdated: new Date(this.lastFetchTime || Date.now()).toISOString(),
    };

    return this.providerStatus;
  }

  /** Regista callback para quando os dias +1..+8 estiverem carregados. */
  public onAiscoreBackfillDone(cb: () => void): void {
    this.backfillCallbacks.push(cb);
  }

  public async getMatches(forceRefresh = false): Promise<MatchItem[]> {
    const oddsKey = process.env.ODDS_API_KEY?.trim();
    const now = Date.now();
    const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

    if (oddsKey && oddsKey !== 'sua_chave_the_odds_api_aqui' && oddsKey.length > 5) {
      if (forceRefresh || now - this.lastFetchTime > CACHE_TTL_MS || this.matches.length === 0) {
        if (!this.activeFetchPromise) {
          this.activeFetchPromise = this.fetchFromOddsApi(oddsKey)
            .then(() => {
              this.lastFetchTime = Date.now();
              this.saveDiskCache();
            })
            .catch((err) => {
              console.error('[MarketService] Erro ao buscar The Odds API:', err);
            })
            .finally(() => {
              this.activeFetchPromise = null;
            });
        }
        await this.activeFetchPromise;
      }
    }

    // Complementa / substitui com AiScore quando não há jogos "hoje" (ou sem chave Odds)
    const hasToday = this.matches.some(
      (m) =>
        m.status !== 'resolved' &&
        getCalendarDayDiff(m.kickoffAt) === 0 &&
        m.kickoffAt > now - 2 * 60 * 60 * 1000
    );
    if (forceRefresh || !hasToday || now - this.aiscoreLastSync > this.AISCORE_TTL_MS) {
      await this.syncFromAiscore(forceRefresh);
    }

    // Retorna estritamente as partidas com kickoff futuro ou partidas recém-resolvidas
    const validMatches = this.matches.filter(
      (m) => m.status === 'resolved' || m.kickoffAt > now - 2 * 60 * 60 * 1000
    );

    return validMatches;
  }

  /**
   * Puxa o day card do AiScore (jogos do dia + 1X2) e funde no mercado.
   * Dia 0 é aguardado (resposta rápida); dias 1..7 seguem em background para
   * alimentar os escopos 2_3_dias/longo — com as ligas principais na frente.
   * Evita duplicar jogos já vindos do The Odds API (match por home/away/data).
   */
  private async syncFromAiscore(force = false): Promise<void> {
    if (this.activeAiscorePromise) {
      await this.activeAiscorePromise;
      return;
    }
    const now = Date.now();
    if (!force && now - this.aiscoreLastSync < this.AISCORE_TTL_MS) {
      return;
    }

    this.activeAiscorePromise = (async () => {
      try {
        const dayZero = this.matches.filter(
          (m) => m.status !== 'resolved' && getCalendarDayDiff(m.kickoffAt) === 0
        ).length;
        if (!force && dayZero > 0 && now - this.aiscoreLastSync < this.AISCORE_TTL_MS) {
          return;
        }

        // Dia 0: aguardado, com odds reais 1X2 para os primeiros priorizados.
        // Como já não usamos odds sintéticas, precisamos de mais jogos reais.
        // A prioridade do bridge inclui Conference, J1, Süper Lig, Saudi Pro
        // League, SuperLiga sérvia e Eredivisie, para que estas ligas não sejam
        // cortadas pelo odds_limit.
        await this.syncAiscoreDay(0, { limit: 200, oddsLimit: 30 });
        this.aiscoreLastSync = Date.now();
        this.saveDiskCache();

        // Dias 1..8 (~1 semana+): background sequencial. Sem odds do AiScore
        // (nos dias futuros quase nunca existem): as odds reais entram depois
        // na geração, via Premier Bet. Assim cada dia leva segundos e não
        // estoura o timeout de 120s do bridge.
        void (async () => {
          for (let d = 1; d <= 8; d++) {
            try {
              await this.syncAiscoreDay(d, { limit: 200, oddsLimit: 0 });
            } catch (err: any) {
              console.warn(`[MarketService] AiScore dia +${d} falhou:`, err?.message);
            }
          }
          console.log('[MarketService] AiScore multi-dia (+1..+8) concluído.');
          this.saveDiskCache();
          // Avisa o agendador para repor as quotas agora que há jogos futuros.
          this.backfillCallbacks.forEach((cb) => {
            try {
              cb();
            } catch (err: any) {
              console.warn('[MarketService] callback de backfill falhou:', err?.message);
            }
          });
        })().catch(() => undefined);
      } catch (err: any) {
        console.warn('[MarketService] AiScore sync falhou:', err?.message);
      } finally {
        this.activeAiscorePromise = null;
      }
    })();

    await this.activeAiscorePromise;
  }

  /** Busca e funde o day card de UM dia (offset a partir de hoje). */
  private async syncAiscoreDay(
    offsetDays: number,
    opts: { limit: number; oddsLimit: number }
  ): Promise<number> {
    const now = Date.now();
    const ymd = aiscoreYmd(offsetDays);
    const card = await aiscoreClient.getDayCard(ymd, {
      upcoming: true,
      limit: opts.limit,
      withOdds: opts.oddsLimit > 0,
      oddsLimit: opts.oddsLimit,
    });

        const timezone = 'Africa/Luanda';
        const existingKeys = new Set(
          this.matches.map(
            (m) => `${m.home.toLowerCase()}||${m.away.toLowerCase()}||${m.dateStr || ''}||${m.league.toLowerCase()}`
          )
        );
        const added: MatchItem[] = [];

        for (const meta of card.data) {
          const kickoffAt = parseKickoffMs(meta.kickoff);
          if (!kickoffAt || kickoffAt <= now - 2 * 60 * 60 * 1000) continue;
          if (meta.statusId != null && meta.statusId !== 1) continue;

          const home = (meta.home?.name || '').trim();
          const away = (meta.away?.name || '').trim();
          if (!home || !away) continue;

          const league = meta.competition || 'AiScore';
          if (isWomensLeague(league)) continue; // femininos nem entram no mercado

          const daysFromNow = getCalendarDayDiff(kickoffAt, timezone);
          const kickoffInSeconds = Math.max(30, Math.round((kickoffAt - now) / 1000));
          const matchDate = new Date(kickoffAt);
          const dateStr = matchDate.toLocaleDateString('pt-PT', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: timezone,
          });

          // Chave inclui data+liga (formato dia, não ms exato): mesmo confronto
          // em dias diferentes não colide; OddsAPI vs AiScore fundem no dia.
          const dedupeKey = `${home.toLowerCase()}||${away.toLowerCase()}||${dateStr}||${league.toLowerCase()}`;
          if (existingKeys.has(dedupeKey)) continue;
          existingKeys.add(dedupeKey);

          // O jogo entra SEMPRE no horizonte (mesmo sem odd no feed). Os
          // placeholders NUNCA são marcados como reais (`realMarkets` fica
          // vazio) — as odds reais são anexadas depois, na geração, via
          // Premier Bet. Antes, descartar jogos sem odds era o que deixava o
          // horizonte longo sem mercado (os dias futuros quase não têm odds).
          const real = meta.odds;
          const validReal = Boolean(
            real &&
              [real.home, real.draw, real.away].every(
                (v) => Number.isFinite(v) && v > 1.01 && v < 1000
              )
          );
          const overround = validReal
            ? 1 / real!.home + 1 / real!.draw + 1 / real!.away
            : 0;
          const hasReal =
            validReal && overround >= 0.9 && overround <= 1.3;

          const odds: MatchOdds = hasReal
            ? {
                home: real!.home,
                draw: real!.draw,
                away: real!.away,
                over25: 1.90,
                under25: 1.90,
                btts_yes: 1.85,
                btts_no: 1.90,
                realMarkets: ['home', 'draw', 'away'],
              }
            : {
                // Placeholders neutros; realMarkets vazio = sem preço real.
                home: 2.60,
                draw: 3.30,
                away: 2.90,
                over25: 1.90,
                under25: 1.90,
                btts_yes: 1.85,
                btts_no: 1.90,
                realMarkets: [],
              };

          const timeStr = matchDate.toLocaleTimeString('pt-PT', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone,
          });

          const rawItem = {
            id: `aiscore_${meta.match_id}`,
            league,
            competitionId: meta.competition_id ?? null,
            home,
            away,
            time: timeStr,
            dateStr,
            daysFromNow,
            kickoffInSeconds,
            kickoffAt,
            odds,
            context: null,
          };

          added.push({
            ...rawItem,
            tip: hasReal
              ? scoreMatch(rawItem)
              : {
                  market: 'home' as MarketType,
                  label: 'Sem odds reais (a obter na Premier Bet)',
                  odds: 0,
                  prob: 0,
                },
            status: 'pending',
            result: null,
            sourceProvider: 'aiscore',
          });
        }

        if (added.length > 0) {
          this.matches = [...this.matches, ...added];
          console.log(`[MarketService] AiScore day_card: +${added.length} jogos (${ymd}).`);
        }
        this.updateProviderStatusAfterAiscore(card.oddsCount, added.length);
        return added.length;
  }

  private updateProviderStatusAfterAiscore(oddsCount: number, added: number): void {
    const hasOddsKey = Boolean(
      process.env.ODDS_API_KEY?.trim() &&
        process.env.ODDS_API_KEY!.trim().length > 5 &&
        process.env.ODDS_API_KEY!.trim() !== 'sua_chave_the_odds_api_aqui'
    );
    if (hasOddsKey) {
      const leagues = Array.from(new Set(this.matches.map((m) => m.league)));
      this.providerStatus = {
        ...this.providerStatus,
        totalMatches: this.matches.length,
        activeLeagues: leagues,
        lastUpdated: new Date(this.aiscoreLastSync).toISOString(),
        message:
          `The Odds API + AiScore day card (${added} extra, ${oddsCount} odds 1X2). Jogos de hoje cobertos.`,
      };
      return;
    }
    this.providerStatus = {
      ...this.providerStatus,
      provider: 'aiscore',
      providerName: 'AiScore API (day card + odds 1X2)',
      isExternalApi: true,
      apiKeyConfigured: true,
      totalMatches: this.matches.length,
      activeLeagues: Array.from(new Set(this.matches.map((m) => m.league))),
      lastUpdated: new Date(this.aiscoreLastSync).toISOString(),
      message: `Fonte ativa: AiScore (${this.matches.length} jogos, ${oddsCount} com odds 1X2 reais).`,
    };
  }

  private averageH2hOdds(bookmakers: any[], homeTeam: string, awayTeam: string) {
    let homeSum = 0, homeCount = 0;
    let drawSum = 0, drawCount = 0;
    let awaySum = 0, awayCount = 0;

    for (const bm of bookmakers || []) {
      const h2h = bm.markets?.find((m: any) => m.key === 'h2h');
      if (!h2h?.outcomes) continue;

      for (const outcome of h2h.outcomes) {
        if (outcome.name === homeTeam) {
          homeSum += outcome.price;
          homeCount++;
        } else if (outcome.name === awayTeam) {
          awaySum += outcome.price;
          awayCount++;
        } else if (outcome.name === 'Draw' || outcome.name === 'Empate') {
          drawSum += outcome.price;
          drawCount++;
        }
      }
    }

    return {
      home: homeCount ? homeSum / homeCount : null,
      draw: drawCount ? drawSum / drawCount : null,
      away: awayCount ? awaySum / awayCount : null,
    };
  }

  private averageTotals25(bookmakers: any[]) {
    let overSum = 0, overCount = 0, underSum = 0, underCount = 0;

    for (const bm of bookmakers || []) {
      const totals = bm.markets?.find((m: any) => m.key === 'totals');
      if (!totals?.outcomes) continue;
      for (const outcome of totals.outcomes) {
        if (outcome.point !== 2.5) continue;
        if (outcome.name === 'Over') {
          overSum += outcome.price;
          overCount++;
        } else if (outcome.name === 'Under') {
          underSum += outcome.price;
          underCount++;
        }
      }
    }

    return {
      over25: overCount ? overSum / overCount : null,
      under25: underCount ? underSum / underCount : null,
    };
  }

  private averageBtts(bookmakers: any[]) {
    let yesSum = 0, yesCount = 0, noSum = 0, noCount = 0;

    for (const bm of bookmakers || []) {
      const btts = bm.markets?.find((m: any) => m.key === 'btts');
      if (!btts?.outcomes) continue;
      for (const outcome of btts.outcomes) {
        if (outcome.name === 'Yes') {
          yesSum += outcome.price;
          yesCount++;
        } else if (outcome.name === 'No') {
          noSum += outcome.price;
          noCount++;
        }
      }
    }

    return {
      yes: yesCount ? yesSum / yesCount : null,
      no: noCount ? noSum / noCount : null,
    };
  }

  private async fetchFromOddsApi(apiKey: string) {
    const envSports = process.env.ODDS_API_SPORTS?.split(',').map((s) => s.trim()).filter(Boolean);
    
    const sports = envSports && envSports.length > 0 ? envSports : [
      'soccer_epl',
      'soccer_spain_la_liga',
      'soccer_italy_serie_a',
      'soccer_germany_bundesliga',
      'soccer_france_ligue_one',
      'soccer_brazil_campeonato',
      'soccer_uefa_champs_league',
      'soccer_uefa_europa_league',
      'soccer_portugal_primeira_liga',
    ];

    const regions = process.env.ODDS_API_REGIONS || 'eu';
    const markets = process.env.ODDS_API_MARKETS || 'h2h';
    const newMatches: MatchItem[] = [];
    const now = Date.now();
    const timezone = 'Africa/Luanda';

    const sportLeagueMap: Record<string, string> = {
      soccer_epl: 'Premier League',
      soccer_spain_la_liga: 'La Liga',
      soccer_italy_serie_a: 'Serie A',
      soccer_germany_bundesliga: 'Bundesliga',
      soccer_france_ligue_one: 'Ligue 1',
      soccer_brazil_campeonato: 'Brasileirão',
      soccer_uefa_champs_league: 'Champions League',
      soccer_uefa_europa_league: 'Europa League',
      soccer_portugal_primeira_liga: 'Liga Portugal',
    };

    for (const sport of sports) {
      try {
        // Janela explícita de 8 dias: sem commenceTimeTo a The Odds API só
        // devolve os próximos dias e o longo prazo ficava sem jogos.
        const fromIso = new Date(now - 60 * 60 * 1000).toISOString();
        const toIso = new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString();
        const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=decimal&dateFormat=iso&commenceTimeFrom=${encodeURIComponent(fromIso)}&commenceTimeTo=${encodeURIComponent(toIso)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });

        const remaining = resp.headers.get('x-requests-remaining');
        const used = resp.headers.get('x-requests-used');
        if (remaining !== null || used !== null) {
          const reqRemaining = remaining !== null ? parseInt(remaining, 10) : undefined;
          const reqUsed = used !== null ? parseInt(used, 10) : undefined;
          this.providerStatus.rateLimitInfo = {
            requestsRemaining: reqRemaining,
            requestsUsed: reqUsed,
          };
        }

        if (resp.status === 429 || resp.status === 401) break;
        if (!resp.ok) continue;

        const data = await resp.json();
        if (!Array.isArray(data)) continue;

        for (const event of data) {
          const commenceTime = new Date(event.commence_time).getTime();
          // Ignora partidas do passado
          if (commenceTime <= now - 2 * 60 * 60 * 1000) continue;

          const h2h = this.averageH2hOdds(event.bookmakers, event.home_team, event.away_team);
          const totals = this.averageTotals25(event.bookmakers);
          const btts = this.averageBtts(event.bookmakers);

          if (h2h.home === null || h2h.draw === null || h2h.away === null) continue;

          const daysFromNow = getCalendarDayDiff(commenceTime, timezone);
          const diffMs = commenceTime - now;
          const kickoffInSeconds = Math.max(30, Math.round(diffMs / 1000));

          const realMarkets: MarketType[] = ['home', 'draw', 'away'];
          if (totals.over25 != null && totals.under25 != null) {
            realMarkets.push('over25', 'under25');
          }
          if (btts.yes != null && btts.no != null) {
            realMarkets.push('btts_yes', 'btts_no');
          }

          const odds = {
            home: Number(h2h.home.toFixed(2)),
            draw: Number(h2h.draw.toFixed(2)),
            away: Number(h2h.away.toFixed(2)),
            over25: totals.over25 ? Number(totals.over25.toFixed(2)) : 1.90,
            under25: totals.under25 ? Number(totals.under25.toFixed(2)) : 1.90,
            btts_yes: btts.yes ? Number(btts.yes.toFixed(2)) : 1.85,
            btts_no: btts.no ? Number(btts.no.toFixed(2)) : 1.90,
            realMarkets,
          };

          const matchDate = new Date(commenceTime);
          const dateStr = matchDate.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone });
          const timeStr = matchDate.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: timezone });

          const rawItem = {
            id: `oddsapi_${event.id}`,
            league: sportLeagueMap[sport] || event.sport_title || 'Internacional',
            home: event.home_team,
            away: event.away_team,
            time: timeStr,
            dateStr,
            daysFromNow,
            kickoffInSeconds,
            kickoffAt: commenceTime,
            odds,
            context: null,
          };

          newMatches.push({
            ...rawItem,
            tip: scoreMatch(rawItem),
            status: 'pending',
            result: null,
            sourceProvider: 'the-odds-api',
          });
        }
      } catch (err: any) {
        console.warn(`[MarketService] Falha ao sincronizar esporte ${sport}:`, err?.message);
      }
    }

    if (newMatches.length > 0) {
      // Merge (não overwrite): preserva jogos AiScore e pernas de slips pendentes.
      // Nunca rebaixa estado: live/resolved existente vence pending recém-chegado.
      const matchMap = new Map<string, MatchItem>();
      for (const m of this.matches) {
        matchMap.set(m.id, m);
      }
      for (const m of newMatches) {
        const existing = matchMap.get(m.id);
        if (!existing || existing.status === 'pending') {
          matchMap.set(m.id, m);
        }
      }
      this.matches = Array.from(matchMap.values());
    }
  }

  public getMatchById(id: string): MatchItem | undefined {
    return this.matches.find((m) => m.id === id);
  }

  /** Cache matchId interno -> aiscore match_id (evita re-resolve por nomes). */
  private aiscoreIdCache = new Map<string, string>();

  /** Falhas de resolução (evita head-of-line blocking no tick). */
  private resolveFails = new Map<string, { n: number; at: number }>();

  /** Normaliza nomes de equipas para o fallback por nome. */
  private static normName(name?: string | null): string {
    return (name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Resolve em MASSA com UMA chamada ao day card (matches?date=), que já traz
   * statusId + placares empacotados. Só aplica jogos terminados.
   *
   * `allowIds` permite criar a partida em memória quando ela ainda não está na
   * lista mas é perna de uma ficha pendente (ex.: servidor reiniciou depois do
   * jogo ter terminado).
   */
  public async resolveFromDayResults(
    opts: { offsets?: number[]; allowIds?: Set<string> } = {}
  ): Promise<MatchItem[]> {
    const offsets = opts.offsets ?? [0, -1];
    const allowIds = opts.allowIds ?? new Set<string>();
    const resolved: MatchItem[] = [];

    for (const offset of offsets) {
      let metas: Awaited<ReturnType<typeof aiscoreClient.getMatchesForDate>> = [];
      try {
        metas = await aiscoreClient.getMatchesForDate(aiscoreYmd(offset));
      } catch (err: any) {
        console.warn(
          `[Resultados] matches?date (offset ${offset}) falhou:`,
          err?.message
        );
        continue;
      }

      for (const meta of metas) {
        if (!meta.finished) continue;
        if (meta.ft_home == null || meta.ft_away == null) continue;
        const id = `aiscore_${meta.match_id}`;

        let local = this.matches.find((m) => m.id === id);
        if (!local) {
          // Fallback por nomes + data (ex.: jogo veio da The Odds API).
          const home = MarketService.normName(meta.home?.name);
          const away = MarketService.normName(meta.away?.name);
          const kickoff = parseKickoffMs(meta.kickoff);
          local = this.matches.find((m) => {
            if (MarketService.normName(m.home) !== home) return false;
            if (MarketService.normName(m.away) !== away) return false;
            if (!kickoff) return true;
            return Math.abs(m.kickoffAt - kickoff) <= 6 * 60 * 60 * 1000;
          });
        }
        if (!local && allowIds.has(id)) {
          const kickoff = parseKickoffMs(meta.kickoff);
          if (!kickoff) continue;
          local = this.placeholderFromMeta(meta, kickoff);
          this.matches.push(local);
        }
        if (!local || local.status === 'resolved') continue;

        const result = this.applyRealResult(local.id, meta.ft_home, meta.ft_away);
        if (result) resolved.push(result);
      }
    }

    if (resolved.length > 0) {
      console.log(
        `[Resultados] ${resolved.length} jogo(s) resolvido(s) pela varredura do dia.`
      );
    }
    return resolved;
  }

  /** Cria um MatchItem mínimo (sem odds reais) a partir do day card. */
  private placeholderFromMeta(
    meta: Awaited<ReturnType<typeof aiscoreClient.getMatchesForDate>>[number],
    kickoffAt: number
  ): MatchItem {
    const timezone = 'Africa/Luanda';
    const home = (meta.home?.name || '').trim() || 'Casa';
    const away = (meta.away?.name || '').trim() || 'Fora';
    const date = new Date(kickoffAt);
    const dateStr = date.toLocaleDateString('pt-PT', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone,
    });
    const time = date.toLocaleTimeString('pt-PT', {
      hour: '2-digit', minute: '2-digit', timeZone: timezone,
    });
    const odds: MatchOdds = {
      home: 2.6, draw: 3.3, away: 2.9,
      over25: 1.9, under25: 1.9, btts_yes: 1.85, btts_no: 1.9,
      realMarkets: [],
    };
    return {
      id: `aiscore_${meta.match_id}`,
      league: meta.competition || 'AiScore',
      competitionId: meta.competition_id ?? null,
      home, away, time, dateStr,
      daysFromNow: getCalendarDayDiff(kickoffAt, timezone),
      kickoffAt,
      kickoffInSeconds: Math.max(30, Math.round((kickoffAt - Date.now()) / 1000)),
      odds,
      tip: {
        market: 'home',
        label: 'Sem odds reais',
        odds: 0,
        prob: 0,
      },
      context: null,
      status: 'pending',
      result: null,
      sourceProvider: 'aiscore',
    };
  }

  private async resolveAiscoreId(match: MatchItem): Promise<string | null> {
    if (match.id.startsWith('aiscore_')) return match.id.slice('aiscore_'.length);
    const cached = this.aiscoreIdCache.get(match.id);
    if (cached) return cached;
    try {
      const dateKey = aiscoreDateKey(match.kickoffAt);
      const meta = await aiscoreClient.resolveMatchId(match.home, match.away, dateKey);
      if (meta?.match_id) {
        this.aiscoreIdCache.set(match.id, meta.match_id);
        return meta.match_id;
      }
    } catch {
      /* sem id real -> sem resolução (nunca inventar) */
    }
    return null;
  }

  /**
   * Aplica um placar REAL (FT) a uma partida. Puro e síncrono.
   * É a ÚNICA via de resolução — nada aqui gera resultado aleatório.
   */
  public applyRealResult(id: string, ftHome: number, ftAway: number): MatchItem | null {
    const match = this.matches.find((m) => m.id === id);
    if (!match || match.status === 'resolved') return match || null;
    if (!Number.isFinite(ftHome) || !Number.isFinite(ftAway)) return null;

    const homeScore = ftHome;
    const awayScore = ftAway;
    const totalGoals = homeScore + awayScore;
    const isHomeWin = homeScore > awayScore;
    const isAwayWin = awayScore > homeScore;
    const isDraw = homeScore === awayScore;

    const outcome1x2 = isHomeWin ? 'home' : isAwayWin ? 'away' : 'draw';
    const outcomeOU = totalGoals >= 3 ? 'over25' : 'under25';
    const outcomeBtts = homeScore > 0 && awayScore > 0 ? 'btts_yes' : 'btts_no';

    const actual: Record<MarketType, boolean> = {
      home: isHomeWin,
      draw: isDraw,
      away: isAwayWin,
      double_chance_1x: isHomeWin || isDraw,
      double_chance_x2: isAwayWin || isDraw,
      double_chance_12: isHomeWin || isAwayWin,
      over15: totalGoals >= 2,
      over25: totalGoals >= 3,
      over35: totalGoals >= 4,
      under25: totalGoals <= 2,
      under35: totalGoals <= 3,
      btts_yes: homeScore > 0 && awayScore > 0,
      btts_no: homeScore === 0 || awayScore === 0,
      dnb_home: isHomeWin,
      dnb_away: isAwayWin,
    };

    // Empate no DNB = push (reembolso). Sem modelo de void no BetSlip, a perna
    // conta como acerto para não derrubar injustamente o bilhete inteiro.
    let tipWon = !!actual[match.tip.market];
    let pushed = false;
    if (isDraw && (match.tip.market === 'dnb_home' || match.tip.market === 'dnb_away')) {
      tipWon = true;
      pushed = true;
    }

    match.status = 'resolved';
    match.result = {
      homeScore,
      awayScore,
      outcome1x2,
      outcomeOU,
      outcomeBtts,
      tipWon,
      pushed,
    };
    return match;
  }

  /**
   * Tenta resolver UMA partida com o placar real do AiScore (match/data).
   * - Jogo terminado (statusId 8) com FT válido -> resolved.
   * - Jogo já iniciado mas sem FT -> marca 'live'.
   * - Sem dados reais -> não toca (retorna null). Nunca inventa placar.
   */
  public async resolveMatchLive(id: string): Promise<MatchItem | null> {
    const match = this.matches.find((m) => m.id === id);
    if (!match || match.status === 'resolved') return match || null;

    const aiscoreId = await this.resolveAiscoreId(match);
    if (!aiscoreId) return null;

    const live = await aiscoreClient.getLiveResult(aiscoreId);
    if (!live) return null;

    if (live.finished && live.ft_home != null && live.ft_away != null) {
      return this.applyRealResult(id, live.ft_home, live.ft_away);
    }
    if (Date.now() >= match.kickoffAt && match.status === 'pending') {
      match.status = 'live';
    }
    return null;
  }

  /**
   * Varredura periódica: resolve com placar real apenas jogos terminados.
   * Limitado a N partidas por tick (cada consulta ~1.7s de throttle).
   * Partidas que falham 3x seguidas são puladas por 30min (sem head-of-line).
   */
  public async resolveDueMatches(
    maxPerTick = 8,
    priorityIds?: Set<string>
  ): Promise<MatchItem[]> {
    const now = Date.now();
    const resolved: MatchItem[] = [];
    const due = this.matches.filter((m) => {
      if (m.status === 'resolved' || now < m.kickoffAt) return false;
      const fail = this.resolveFails.get(m.id);
      if (fail && fail.n >= 3 && now - fail.at < 30 * 60 * 1000) return false;
      return true;
    });
    // Pernas de fichas pendentes primeiro; depois os terminados há mais tempo
    // (bilhetes expiram mais rápido).
    due.sort((a, b) => {
      const pa = priorityIds?.has(a.id) ? 0 : 1;
      const pb = priorityIds?.has(b.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.kickoffAt - b.kickoffAt;
    });
    for (const m of due.slice(0, maxPerTick)) {
      try {
        const res = await this.resolveMatchLive(m.id);
        if (res) {
          resolved.push(res);
          this.resolveFails.delete(m.id);
        }
      } catch (err: any) {
        console.warn(`[MarketService] Falha ao resolver ${m.home} vs ${m.away}:`, err?.message);
        const fail = this.resolveFails.get(m.id);
        this.resolveFails.set(m.id, { n: (fail?.n || 0) + 1, at: Date.now() });
      }
    }
    return resolved;
  }

  /**
   * @deprecated Simulação manual — só ativa com ALLOW_SIMULATION=true (dev).
   * Em produção retorna null e nunca resolve nada.
   */
  public resolveMatch(id?: string): MatchItem | null {
    if (process.env.ALLOW_SIMULATION !== 'true') {
      console.warn('[MarketService] resolveMatch manual bloqueado em produção (ALLOW_SIMULATION!=true).');
      return null;
    }
    let match: MatchItem | undefined;
    if (id) {
      match = this.matches.find((m) => m.id === id);
    } else {
      match = this.matches.find((m) => m.status === 'pending');
    }
    if (!match || match.status === 'resolved') return match || null;
    // Modo dev: placar sintético apenas para testes locais.
    const homeScore = 2;
    const awayScore = 1;
    return this.applyRealResult(match.id, homeScore, awayScore);
  }

  /**
   * @deprecated Use resolveDueMatches() (assíncrono, placar real).
   * Mantido para compat: só marca 'live' jogos iniciados, nunca resolve.
   */
  public resolveAllOverdue(): MatchItem[] {
    const now = Date.now();
    for (const match of this.matches) {
      if (match.status === 'pending' && now >= match.kickoffAt) {
        match.status = 'live';
      }
    }
    return [];
  }

  public resetMatches(): MatchItem[] {
    this.matches = [];
    this.lastFetchTime = 0;
    this.aiscoreLastSync = 0;
    this.aiscoreIdCache.clear();
    this.resolveFails.clear();
    if (fs.existsSync(CACHE_FILE_PATH)) {
      try {
        fs.unlinkSync(CACHE_FILE_PATH);
      } catch (e) {}
    }
    return this.matches;
  }
}

export const marketService = new MarketService();
