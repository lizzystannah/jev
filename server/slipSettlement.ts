/**
 * Liquidação de fichas: função pura (não persiste) usada tanto pelo scheduler
 * como pela reparação de fichas antigas. O estado da perna distingue
 * `void` (push/reembolso) de `lost`, para uma perna anulada não derrubar a
 * ficha inteira.
 */
import type { BetSlip, MatchItem } from './types.js';
import { marketOutcomeFor } from './outcomes.js';

export type LegState = 'pending' | 'won' | 'lost' | 'void';

/**
 * Estado efetivo da perna.
 *
 * Uma perna `resolved` SEM `result` continua pendente: sem placar não há
 * resultado, e dar-lhe `won` inflaciona as estatísticas de acerto.
 * `tipWon === true` conta como vitória; `undefined` conta como derrota
 * (nunca como vitória).
 */
export function legState(leg: Pick<MatchItem, 'status' | 'result'>): LegState {
  if (leg.status !== 'resolved' || !leg.result) return 'pending';
  if (leg.result.pushed) return 'void';
  return leg.result.tipWon === true ? 'won' : 'lost';
}

/**
 * Recalcula `tipWon`/`pushed` a partir do placar e do mercado da própria perna.
 * Devolve true quando alterou o resultado.
 *
 * Um mercado desconhecido LANÇA dentro de `marketOutcomeFor`: apanha-se aqui e
 * o resultado antigo é preservado (nunca trocar um acerto por uma perda por
 * causa de um erro de código).
 */
export function recomputeLegResult(leg: MatchItem): boolean {
  const res = leg.result;
  if (!res || res.homeScore == null || res.awayScore == null) return false;
  let outcome;
  try {
    outcome = marketOutcomeFor(leg.tip.market, res.homeScore, res.awayScore);
  } catch (err: any) {
    console.warn(
      `[settle] perna ${leg.id} (${leg.tip.market}): ${err?.message}; resultado preservado.`
    );
    return false;
  }
  if (res.tipWon !== outcome.won || (res.pushed ?? false) !== outcome.pushed) {
    leg.result = { ...res, tipWon: outcome.won, pushed: outcome.pushed };
    return true;
  }
  return false;
}

/**
 * Odd efetiva: produto das pernas não-void. Uma perna anulada deixa de contar
 * para a odd, em vez de derrubar a ficha. Devolve true quando atualizou.
 *
 * `tip.odds` nulo (ou inválido) não pode virar 0: trata-se como 1.00 e avisa.
 */
export function updateEffectiveOdds(slip: BetSlip): boolean {
  let odd = 1;
  for (const leg of slip.legs) {
    if (legState(leg) === 'void') continue;
    const o = leg.tip?.odds;
    if (o == null || !Number.isFinite(o) || o < 1) {
      console.warn(
        `[settle] ${slip.id}: perna ${leg.id} sem odd válida (${o}); tratada como 1.00.`
      );
      continue;
    }
    odd *= o;
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
  /**
   * true no tick normal: fichas já terminais não mudam de estado.
   * false só na reparação de histórico.
   */
  lockTerminal?: boolean;
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
 *
 * Uma ficha sem pernas NÃO é "anulada" por acidente (`[].every()` é true):
 * devolve o estado sem tocar no status.
 */
export function settleSlip(slip: BetSlip, opts: SettleOptions): SettleResult {
  const now = opts.now ?? Date.now();
  if (slip.legs.length === 0) {
    return { changed: false, anyLost: false, allSettled: false, states: [] };
  }
  const wasTerminal = TERMINAL.has(slip.status);
  // Garante que pushes/resultados estão coerentes mesmo em fichas antigas.
  for (const leg of slip.legs) recomputeLegResult(leg);
  const states = slip.legs.map(legState);
  const anyLost = states.includes('lost');
  const allSettled = states.every((s) => s !== 'pending');
  let changed = updateEffectiveOdds(slip);

  if (wasTerminal && opts.lockTerminal) {
    return { changed, anyLost, allSettled, states };
  }

  const before = slip.status;
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

  if (wasTerminal && slip.status !== before) {
    console.warn(
      `[settle] ${slip.id}: ${before} → ${slip.status} em ficha já terminal (reparação).`
    );
  }

  return { changed, anyLost, allSettled, states };
}
