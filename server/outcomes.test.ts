import { describe, expect, it } from 'vitest';
import { marketOutcomeFor } from './outcomes.js';

type Score = [number, number];

const SCORES: Score[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [2, 1],
  [3, 3],
];

/** esperado por mercado: sequência de won para os placares de SCORES. */
const TABLE: Record<string, boolean[]> = {
  //          0-0  1-0  0-1  1-1  2-1  3-3
  home: [false, true, false, false, true, false],
  draw: [true, false, false, true, false, true],
  away: [false, false, true, false, false, false],
  double_chance_1x: [true, true, false, true, true, true],
  double_chance_x2: [true, false, true, true, false, true],
  double_chance_12: [false, true, true, false, true, false],
  btts_yes: [false, false, false, true, true, true],
  btts_no: [true, true, true, false, false, false],
  over15: [false, false, false, true, true, true],
  over25: [false, false, false, false, true, true],
  over35: [false, false, false, false, false, true],
  under25: [true, true, true, true, false, false],
  under35: [true, true, true, true, true, false],
  // Compostas
  home_over25: [false, false, false, false, true, false],
  home_btts_yes: [false, false, false, false, true, false],
  // btts_yes_under15 é IMPOSSÍVEL (BTTS exige ≥2 golos)
  btts_yes_under15: [false, false, false, false, false, false],
  // btts_yes_over15 é igual a btts_yes (redundante)
  btts_yes_over15: [false, false, false, true, true, true],
  // btts_no_under15 é igual a under15 (redundante)
  btts_no_under15: [true, true, true, false, false, false],
};

describe('marketOutcomeFor', () => {
  for (const [market, expected] of Object.entries(TABLE)) {
    it(`${market}: resultado por placar`, () => {
      SCORES.forEach(([h, a], i) => {
        const out = marketOutcomeFor(market, h, a);
        expect(out.won, `${market} ${h}-${a}`).toBe(expected[i]);
        expect(out.pushed).toBe(false);
      });
    });
  }

  it('DNB com empate é push (nunca vitória)', () => {
    for (const market of ['dnb_home', 'dnb_away']) {
      const out = marketOutcomeFor(market, 1, 1);
      expect(out.pushed).toBe(true);
      expect(out.won).toBe(false);
    }
  });

  it('DNB sem empate decide pela victory', () => {
    expect(marketOutcomeFor('dnb_home', 2, 1)).toEqual({ won: true, pushed: false });
    expect(marketOutcomeFor('dnb_away', 2, 1)).toEqual({ won: false, pushed: false });
  });

  it('mercado desconhecido LANÇA (nunca uma derrota silenciosa)', () => {
    expect(() => marketOutcomeFor('mercado_inexistente', 1, 0)).toThrow();
  });

  it('linhas de golos compostas (over45/under15) são reconhecidas', () => {
    expect(marketOutcomeFor('over45', 3, 3).won).toBe(true); // 6 golos > 4.5
    expect(marketOutcomeFor('over45', 2, 1).won).toBe(false); // 3 golos < 4.5
    expect(marketOutcomeFor('under15', 1, 0).won).toBe(true); // 1 golo < 1.5
    expect(marketOutcomeFor('under15', 2, 1).won).toBe(false); // 3 golos > 1.5
  });
});
