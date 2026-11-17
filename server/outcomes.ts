/**
 * Resultado de um mercado para um placar final.
 *
 * Módulo PURO (sem cache, sem timers, sem I/O) para poder ser importado
 * tanto pela liquidação das fichas como pelo motor de mercado.
 *
 * Regras:
 *  - `pushed: true` (DNB com empate, mercado anulado) NUNCA conta como
 *    vitória: `won` é false e a perna é tratada como neutra.
 *  - Mercado desconhecido LANÇA: um erro silencioso aqui transforma uma
 *    perna ganha numa perdida (ou vice-versa). Quem chama apanha o erro e
 *    decide — nunca se inventa o resultado.
 */
import { compostaOutcome, isCompostaMarket } from './compostas.js';
import type { MarketType } from './types.js';

export interface LegOutcome {
  won: boolean;
  pushed: boolean;
}

const W = (won: boolean): LegOutcome => ({ won, pushed: false });
const PUSH: LegOutcome = { won: false, pushed: true };

/** Linhas de golos suportadas (over15/25/35/45 e under15/25/35/45). */
const TOTAL_LINE = /^(over|under)(\d)(\d)$/;

export function marketOutcomeFor(
  market: MarketType | string,
  homeScore: number,
  awayScore: number
): LegOutcome {
  if (isCompostaMarket(market)) {
    return W(compostaOutcome(market, homeScore, awayScore));
  }
  const total = homeScore + awayScore;
  switch (market) {
    case 'home':
      return W(homeScore > awayScore);
    case 'draw':
      return W(homeScore === awayScore);
    case 'away':
      return W(awayScore > homeScore);
    case 'double_chance_1x':
      return W(homeScore >= awayScore);
    case 'double_chance_x2':
      return W(awayScore >= homeScore);
    case 'double_chance_12':
      return W(homeScore !== awayScore);
    case 'btts_yes':
      return W(homeScore > 0 && awayScore > 0);
    case 'btts_no':
      return W(!(homeScore > 0 && awayScore > 0));
    case 'dnb_home':
      return homeScore === awayScore ? PUSH : W(homeScore > awayScore);
    case 'dnb_away':
      return homeScore === awayScore ? PUSH : W(awayScore > homeScore);
  }
  const m = TOTAL_LINE.exec(market);
  if (m) {
    const line = Number(m[2]) + 0.5;
    return W(m[1] === 'over' ? total > line : total < line);
  }
  throw new Error(`marketOutcomeFor: mercado desconhecido "${market}"`);
}
