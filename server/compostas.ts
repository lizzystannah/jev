import type {
  BttsOutcome,
  CompostaMarket,
  DcOutcome,
  MarketType,
  ResultOutcome,
  TotalLine,
} from './types.js';

export const TOTAL_LINES: TotalLine[] = [
  'over15',
  'over25',
  'over35',
  'over45',
  'under15',
  'under25',
  'under35',
  'under45',
];

const RESULTS: ResultOutcome[] = ['home', 'draw', 'away'];
const DOUBLE_CHANCES: DcOutcome[] = [
  'double_chance_1x',
  'double_chance_x2',
  'double_chance_12',
];
const BTTS: BttsOutcome[] = ['btts_yes', 'btts_no'];

const TOTAL_VALUE: Record<TotalLine, number> = {
  over15: 1.5,
  over25: 2.5,
  over35: 3.5,
  over45: 4.5,
  under15: 1.5,
  under25: 2.5,
  under35: 3.5,
  under45: 4.5,
};

interface ComboParts {
  base: ResultOutcome | DcOutcome | BttsOutcome;
  total?: TotalLine;
  btts?: BttsOutcome;
}

const PARTS = new Map<CompostaMarket, ComboParts>();
const ALL: CompostaMarket[] = [];

function add(market: CompostaMarket, parts: ComboParts): void {
  PARTS.set(market, parts);
  ALL.push(market);
}

for (const base of RESULTS) {
  for (const total of TOTAL_LINES) add(`${base}_${total}`, { base, total });
}
for (const base of DOUBLE_CHANCES) {
  for (const total of TOTAL_LINES) add(`${base}_${total}`, { base, total });
}
for (const base of BTTS) {
  for (const total of TOTAL_LINES) add(`${base}_${total}`, { base, total });
}
for (const base of RESULTS) {
  for (const btts of BTTS) add(`${base}_${btts}`, { base, btts });
}
for (const base of DOUBLE_CHANCES) {
  for (const btts of BTTS) add(`${base}_${btts}`, { base, btts });
}

export const COMPOSTA_MARKETS: readonly CompostaMarket[] = ALL;
const COMPOSTA_SET = new Set<string>(ALL);

export function isCompostaMarket(market: MarketType | string): market is CompostaMarket {
  return COMPOSTA_SET.has(market);
}

export function compostaLabel(
  market: CompostaMarket,
  ctx: { home: string; away: string }
): string {
  const parts = PARTS.get(market);
  if (!parts) return market;
  const base =
    parts.base === 'home'
      ? `Vitória ${ctx.home}`
      : parts.base === 'away'
      ? `Vitória ${ctx.away}`
      : parts.base === 'draw'
      ? 'Empate'
      : parts.base === 'double_chance_1x'
      ? '1X'
      : parts.base === 'double_chance_x2'
      ? 'X2'
      : parts.base === 'double_chance_12'
      ? '12'
      : parts.base === 'btts_yes'
      ? 'BTTS Sim'
      : 'BTTS Não';
  const condition = parts.total
    ? `${parts.total.startsWith('over') ? 'Over' : 'Under'} ${TOTAL_VALUE[parts.total]}`
    : parts.btts === 'btts_yes'
    ? 'BTTS Sim'
    : 'BTTS Não';
  return `${base} + ${condition}`;
}

function partsOutcome(parts: ComboParts, homeScore: number, awayScore: number): boolean {
  const total = homeScore + awayScore;
  const isHome = homeScore > awayScore;
  const isDraw = homeScore === awayScore;
  const isAway = awayScore > homeScore;
  const btts = homeScore > 0 && awayScore > 0;

  if (parts.base === 'home' && !isHome) return false;
  if (parts.base === 'draw' && !isDraw) return false;
  if (parts.base === 'away' && !isAway) return false;
  if (parts.base === 'double_chance_1x' && !(isHome || isDraw)) return false;
  if (parts.base === 'double_chance_x2' && !(isAway || isDraw)) return false;
  if (parts.base === 'double_chance_12' && !(isHome || isAway)) return false;
  if (parts.base === 'btts_yes' && !btts) return false;
  if (parts.base === 'btts_no' && btts) return false;

  if (parts.total) {
    const line = TOTAL_VALUE[parts.total];
    if (parts.total.startsWith('over') ? total <= line : total >= line) return false;
  }
  if (parts.btts === 'btts_yes' && !btts) return false;
  if (parts.btts === 'btts_no' && btts) return false;
  return true;
}

export function compostaOutcome(
  market: CompostaMarket,
  homeScore: number,
  awayScore: number
): boolean {
  const parts = PARTS.get(market);
  return parts ? partsOutcome(parts, homeScore, awayScore) : false;
}

function poissonPmf(lam: number, k: number): number {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.exp(-lam) * Math.pow(lam, k)) / fact;
}

/**
 * Probabilidade conjunta por Poisson para cada tip composta. Não é o produto
 * das marginais: cada mercado é contado no mesmo par de golos (i, j).
 */
export function poissonCompostaProbs(
  lamH: number,
  lamA: number
): Record<CompostaMarket, number> {
  const out: Record<string, number> = {};
  for (const market of ALL) out[market] = 0;
  for (let i = 0; i <= 12; i++) {
    const ph = poissonPmf(lamH, i);
    if (ph <= 0) continue;
    for (let j = 0; j <= 12; j++) {
      const p = ph * poissonPmf(lamA, j);
      if (p <= 0) continue;
      for (const market of ALL) {
        const parts = PARTS.get(market)!;
        if (partsOutcome(parts, i, j)) out[market] += p;
      }
    }
  }
  return out as Record<CompostaMarket, number>;
}
