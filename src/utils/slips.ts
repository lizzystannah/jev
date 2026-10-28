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

function dayDiffInTz(targetMs: number, nowMs: number, timezone: string): number {
  const targetKey = getDayKeyInTz(targetMs, timezone);
  const nowKey = getDayKeyInTz(nowMs, timezone);
  const target = Date.parse(`${targetKey}T00:00:00Z`);
  const current = Date.parse(`${nowKey}T00:00:00Z`);
  return Math.round((target - current) / (24 * 60 * 60 * 1000));
}

export function matchInScope(
  match: MatchItem,
  scope: ScopeOption,
  now: number = Date.now(),
  timezone = 'Africa/Luanda'
): boolean {
  const dayDiff = dayDiffInTz(match.kickoffAt, now, timezone);
  if (scope === 'dia') {
    return dayDiff === 0 && match.kickoffAt >= now - 2 * 60 * 60 * 1000;
  }
  if (scope === '2_3_dias') {
    return dayDiff >= 1 && dayDiff <= 3;
  }
  return dayDiff >= 4;
}

export function isSlipToday(slip: BetSlip, todayKey: string, timezone: string): boolean {
  return (slip.dayKey || getDayKeyInTz(slip.createdAt, timezone)) === todayKey;
}
