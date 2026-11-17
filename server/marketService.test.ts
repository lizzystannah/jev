import { describe, expect, it } from 'vitest';
import { mergeOdds, sameFixture } from './marketService.js';
import type { MatchItem, MatchOdds } from './types.js';

function odds(patch: Partial<MatchOdds> = {}): MatchOdds {
  return {
    home: 2.0,
    draw: 3.2,
    away: 3.8,
    over25: 1.9,
    under25: 1.95,
    btts_yes: 1.85,
    btts_no: 1.95,
    realMarkets: ['home', 'draw', 'away'],
    ...patch,
  };
}

describe('mergeOdds', () => {
  it('uma odd REAL do fresh substitui a do old', () => {
    const merged = mergeOdds(
      odds({ over25: 2.5, realMarkets: ['home', 'draw', 'away', 'over25'] }),
      odds({ over25: 1.77, realMarkets: ['home', 'draw', 'away', 'over25'] })
    );
    expect(merged.over25).toBe(1.77);
  });

  it('uma ESTIMATIVA do fresh não pisa uma odd real do old', () => {
    // O `fresh` traz over15 estimado (1.4) mas NÃO o lista em realMarkets.
    const merged = mergeOdds(
      odds({ over15: 2.05, realMarkets: ['home', 'draw', 'away', 'over15'] }),
      odds({ over15: 1.4, realMarkets: ['home', 'draw', 'away'] })
    );
    expect(merged.over15).toBe(2.05);
    expect(merged.realMarkets).toContain('over15');
  });

  it('união dos mercados reais e combinação de composed', () => {
    const merged = mergeOdds(
      odds({ realMarkets: ['home', 'draw', 'away'], comboOdds: { home_over25: 3.1 } }),
      odds({ realMarkets: ['over25', 'btts_yes'], comboOdds: { home_over25: 3.4 } })
    );
    expect(merged.realMarkets).toEqual(
      expect.arrayContaining(['home', 'draw', 'away', 'over25', 'btts_yes'])
    );
    expect(merged.comboOdds?.home_over25).toBe(3.4);
  });
});

describe('sameFixture', () => {
  const base = {
    id: 'aiscore_1',
    league: 'Premier League',
    home: 'Manchester City',
    away: 'Arsenal',
    time: '20:00',
    daysFromNow: 0,
    kickoffAt: 1_800_000_000_000,
    kickoffInSeconds: 3600,
    odds: odds(),
    tip: { market: 'home', label: 'x', odds: 2, prob: 50 },
    context: null,
    status: 'pending',
    result: null,
  } as MatchItem;

  it('mesmas equipas e kickoff próximo → mesma fixture', () => {
    expect(sameFixture(base, { ...base, id: 'oddsapi_9' })).toBe(true);
  });

  it('grafias diferentes da mesma equipa → mesma fixture', () => {
    expect(
      sameFixture(base, { ...base, id: 'x', home: 'Man City' })
    ).toBe(true);
  });

  it('equipas diferentes → não é a mesma fixture', () => {
    expect(sameFixture(base, { ...base, id: 'x', home: 'Chelsea' })).toBe(false);
  });

  it('kickoff muito diferente → não é a mesma fixture', () => {
    expect(
      sameFixture(base, { ...base, id: 'x', kickoffAt: base.kickoffAt + 10 * 3600_000 })
    ).toBe(false);
  });
});
