/**
 * Liquidação de fichas: função pura (não persiste) usada tanto pelo scheduler
 * como pela reparação de fichas antigas. O estado da perna distingue
 * `void` (push/reembolso) de `lost`, para uma perna anulada não derrubar a
 * ficha inteira.
 */
import type { BetSlip, MatchItem } from './types.js';
import { marketOutcomeFor } from './marketService.js';

export type LegState = 'pending' | 'won' | 'lost' | 'void';

/** Estado efetivo da perna: push conta como void, nunca como perda. */
export function legState(leg: MatchItem): LegState {
  if (leg.status !== 'resolved') return 'pending';
  if (leg.result?.pushed) return 'void';
  if (leg.result && leg.result.tipWon === false) return 'lost';
  return 'won';
}

/**
 * Recalcula `tipWon`/`pushed` a partir do placar e do mercado da própria perna.
 * Devolve true quando alterou o resultado.
 */
export function recomputeLegResult(leg: MatchItem): boolean {
  const res = leg.result;
  if (!res || res.homeScore == null || res.awayScore == null) return false;
  const outcome = marketOutcomeFor(leg.tip.market, res.homeScore, res.awayScore);
  if (res.tipWon !== outcome.won || (res.pushed ?? false) !== outcome.pushed) {
    leg.result = { ...res, tipWon: outcome.won, pushed: outcome.pushed };
    return true;
  }
  return false;
}

/**
 * Odd efetiva: produto das pernas não-void. Uma perna anulada deixa de contar
 * para a odd, em vez de derrubar a ficha. Devolve true quando atualizou.
 */
export function updateEffectiveOdds(slip: BetSlip): boolean {
  let odd = 1;
  for (const leg of slip.legs) {
    if (legState(leg) === 'void') continue;
    odd *= leg.tip.odds;
  }
  const value = Number(odd.toFixed(2));
  if (slip.effectiveOdds !== value) {
    slip.effectiveOdds = value;
    return true;
  }
  return false;
}

export interface SettleOptions {
  /** Horas de tolerância depois do último pontapé antes de expirar. */
  graceHours: number;
  now?: number;
  /** Aplicar expiração por calendário (false na reparação de histórico). */
  allowExpiry?: boolean;
}

export interface SettleResult {
  changed: boolean;
  anyLost: boolean;
  allSettled: boolean;
  states: LegState[];
}

const TERMINAL: ReadonlySet<BetSlip['status']> = new Set(['ganhou', 'perdeu', 'anulada']);

/**
 * Atualiza `slip.status`/`slip.resolvedAt` in-place conforme as pernas.
 * - qualquer perna perdida → `perdeu` imediatamente;
 * - todas as pernas resolvidas e nenhuma perdida → `ganhou` (ou `anulada` se
 *   todas forem void);
 * - com pernas pendentes, só expira depois do prazo + tolerância.
 */
export function settleSlip(slip: BetSlip, opts: SettleOptions): SettleResult {
  const now = opts.now ?? Date.now();
  // Garante que pushes/resultados estão coerentes mesmo em fichas antigas.
  for (const leg of slip.legs) recomputeLegResult(leg);
  const states = slip.legs.map(legState);
  const anyLost = states.includes('lost');
  const allSettled = states.every((s) => s !== 'pending');
  let changed = updateEffectiveOdds(slip);

  if (anyLost) {
    if (slip.status !== 'perdeu') {
      slip.status = 'perdeu';
      slip.resolvedAt = slip.resolvedAt ?? now;
      changed = true;
    }
  } else if (allSettled) {
    const target: BetSlip['status'] = states.every((s) => s === 'void') ? 'anulada' : 'ganhou';
    if (slip.status !== target) {
      slip.status = target;
      slip.resolvedAt = slip.resolvedAt ?? now;
      changed = true;
    }
  } else if (opts.allowExpiry !== false && !TERMINAL.has(slip.status)) {
    const lastKickoff = slip.legs.reduce((max, l) => Math.max(max, l.kickoffAt || 0), 0);
    const deadline = Math.max(lastKickoff, slip.expiresAt || 0) + opts.graceHours * 60 * 60 * 1000;
    if (now > deadline && slip.status !== 'expirado') {
      slip.status = 'expirado';
      slip.resolvedAt = now;
      changed = true;
    }
  }

  return { changed, anyLost, allSettled, states };
}
