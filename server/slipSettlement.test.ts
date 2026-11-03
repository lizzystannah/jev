import { describe, expect, it } from 'vitest';
import type { BetSlip, MatchItem } from './types.js';
import { legState, settleSlip } from './slipSettlement.js';

function leg(
  overrides: Omit<Partial<MatchItem>, 'tip'> & { tip?: Partial<MatchItem['tip']> }
): MatchItem {
  return {
    id: 'm1',
    league: 'Teste',
    home: 'A',
    away: 'B',
    time: '20:00',
    daysFromNow: 0,
    kickoffAt: Date.now() + 60_000,
    kickoffInSeconds: 60,
    odds: {} as MatchItem['odds'],
    context: null,
    status: 'resolved',
    result: {
      homeScore: 1,
      awayScore: 1,
      outcome1x2: 'draw',
      outcomeOU: 'under25',
      outcomeBtts: 'btts_yes',
      tipWon: true,
    },
    ...overrides,
    tip: {
      market: 'home',
      label: 'Casa',
      odds: 2,
      prob: 50,
      ...overrides.tip,
    },
  } as MatchItem;
}

function slip(legs: MatchItem[]): BetSlip {
  return {
    id: 'S1',
    scope: 'dia',
    tier: 'segura',
    color: '#fff',
    legs,
    combinedOdds: legs.reduce((a, l) => a * l.tip.odds, 1),
    combinedProb: 40,
    expiresAt: Date.now() + 60_000,
    status: 'pendente',
    createdAt: Date.now(),
    resolvedAt: null,
  };
}

describe('slipSettlement', () => {
  it('DNB empatado é void e não derruba a ficha', () => {
    const push = leg({
      id: 'dnb',
      tip: { market: 'dnb_home', odds: 1.9 },
      result: {
        homeScore: 1,
        awayScore: 1,
        outcome1x2: 'draw',
        outcomeOU: 'under25',
        outcomeBtts: 'btts_yes',
        tipWon: true,
        pushed: true,
      },
    });
    const win = leg({ id: 'win', tip: { market: 'home', odds: 2 }, result: {
      homeScore: 2,
      awayScore: 0,
      outcome1x2: 'home',
      outcomeOU: 'under25',
      outcomeBtts: 'btts_no',
      tipWon: true,
    } });
    expect(legState(push)).toBe('void');
    const s = slip([push, win]);
    settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.status).toBe('ganhou');
    expect(s.effectiveOdds).toBeCloseTo(2);
  });

  it('todas void → anulada', () => {
    const s = slip([
      leg({ id: 'a', tip: { market: 'dnb_home' }, result: {
        homeScore: 0,
        awayScore: 0,
        outcome1x2: 'draw',
        outcomeOU: 'under25',
        outcomeBtts: 'btts_no',
        tipWon: false,
      } }),
    ]);
    settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.status).toBe('anulada');
    expect(s.effectiveOdds).toBeCloseTo(1);
  });

  it('uma perna perdida fecha a ficha como perdeu', () => {
    const s = slip([
      leg({ id: 'lost', tip: { market: 'home' }, result: {
        homeScore: 0,
        awayScore: 1,
        outcome1x2: 'away',
        outcomeOU: 'under25',
        outcomeBtts: 'btts_no',
        tipWon: false,
      } }),
    ]);
    settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.status).toBe('perdeu');
  });

  it('expira após o último kickoff + tolerância', () => {
    const s = slip([leg({ status: 'pending', result: null })]);
    s.expiresAt = Date.now() - 7 * 60 * 60 * 1000;
    s.legs[0].kickoffAt = s.expiresAt;
    settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.status).toBe('expirado');
  });
});
