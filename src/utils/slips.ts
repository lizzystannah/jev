import { BetEngine, BetSlip, MatchItem } from '../types.js';
import { getDayKeyInTz } from './timezone.js';

export type ScopeOption = 'dia' | '2_3_dias' | 'longo';

export const SCOPE_OPTIONS: Array<{ id: ScopeOption; label: string }> = [
  { id: 'dia', label: 'Hoje' },
  { id: '2_3_dias', label: '2 a 3 dias' },
  { id: 'longo', label: 'Longo prazo' },
];

export const scopeLabel = (scope: ScopeOption): string =>
  scope === 'dia' ? 'Hoje' : scope === '2_3_dias' ? '2 a 3 Dias' : 'Longo Prazo';

export const engineOf = (slip: BetSlip): BetEngine => slip.engine ?? 'local';

export const byMostRecent = (a: BetSlip, b: BetSlip): number =>
  (b.resolvedAt || b.createdAt) - (a.resolvedAt || a.createdAt);

export function matchInScope(
  match: MatchItem,
  scope: ScopeOption,
  now: number = Date.now()
): boolean {
  if (scope === 'dia') {
    return (
      match.daysFromNow === 0 ||
      (match.kickoffAt - now <= 24 * 60 * 60 * 1000 &&
        match.kickoffAt >= now - 2 * 60 * 60 * 1000)
    );
  }
  if (scope === '2_3_dias') {
    return match.daysFromNow >= 1 && match.daysFromNow <= 3;
  }
  return match.daysFromNow >= 4;
}

export function isSlipToday(slip: BetSlip, todayKey: string, timezone: string): boolean {
  return (slip.dayKey || getDayKeyInTz(slip.createdAt, timezone)) === todayKey;
}
