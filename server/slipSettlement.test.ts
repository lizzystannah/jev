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

  // [SS-1] Uma perna `resolved` SEM `result` não tem resultado: contá-la
  // como ganha dava fichas "ganhou" indevidamente.
  it('perna resolved sem result continua pendente (SS-1)', () => {
    const semResultado = leg({ id: 'nr', status: 'resolved', result: null });
    expect(legState(semResultado)).toBe('pending');
    const s = slip([semResultado]);
    settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.status).toBe('pendente');
  });

  it('tipWon undefined nunca conta como vitória (SS-1)', () => {
    const indefinido = leg({
      id: 'undef',
      result: {
        homeScore: 1,
        awayScore: 0,
        outcome1x2: 'home',
        outcomeOU: 'under25',
        outcomeBtts: 'btts_no',
        tipWon: undefined as unknown as boolean,
      },
    });
    expect(legState(indefinido)).toBe('lost');
  });

  // [SS-2] `tip.odds` nulo não pode virar 0 (a odd efetiva ficava 0).
  it('odd nula na perna não zera a odd efetiva (SS-2)', () => {
    const comOddNula = leg({
      id: 'odd-null',
      tip: { market: 'home', odds: null as unknown as number },
      result: {
        homeScore: 2,
        awayScore: 0,
        outcome1x2: 'home',
        outcomeOU: 'under25',
        outcomeBtts: 'btts_no',
        tipWon: true,
      },
    });
    const s = slip([comOddNula]);
    settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.effectiveOdds).toBeGreaterThan(0);
    expect(s.effectiveOdds).toBeCloseTo(1);
  });

  // [SS-3] Uma ficha sem pernas não é "anulada" por acidente.
  it('ficha sem pernas não muda de estado (SS-3)', () => {
    const s = slip([]);
    const res = settleSlip(s, { graceHours: 6, now: Date.now() });
    expect(s.status).toBe('pendente');
    expect(res.changed).toBe(false);
    expect(res.allSettled).toBe(false);
  });

  // [SS-3] Uma ficha terminal não muda de estado no tick normal.
  it('ficha terminal fica terminal com lockTerminal (SS-3)', () => {
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
    // Reparár o resultado (a perna passou a ganha) não muda a ficha já terminal.
    s.legs[0].result = {
      homeScore: 2,
      awayScore: 0,
      outcome1x2: 'home',
      outcomeOU: 'under25',
      outcomeBtts: 'btts_no',
      tipWon: true,
    };
    settleSlip(s, { graceHours: 6, now: Date.now(), lockTerminal: true });
    expect(s.status).toBe('perdeu');
  });
});
