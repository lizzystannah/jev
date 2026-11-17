import { describe, expect, it } from 'vitest';
import { compostaProbsFromMatrix, isDegenerateComposta, COMPOSTA_CANDIDATES } from './compostas.js';
import { scoreMatrix, marketsFromMatrix } from './scoreModel.js';

describe('compostas', () => {
  it('normaliza uma matriz que não soma 1', () => {
    const M = scoreMatrix(1.5, 1.1, -0.09, 8);
    // Escala a matriz por 2: as probabilidades não podem duplicar.
    const scaled = M.map((row) => row.map((v) => v * 2));
    const a = compostaProbsFromMatrix(M);
    const b = compostaProbsFromMatrix(scaled);
    expect(b.home_over25).toBeCloseTo(a.home_over25, 6);
    const sum = Object.values(a).reduce((acc, v) => acc + v, 0);
    expect(sum).toBeGreaterThan(0);
  });

  it('probabilidades compostas são coerentes com as marginais', () => {
    const M = scoreMatrix(1.6, 1.2, -0.09, 10);
    const p = compostaProbsFromMatrix(M);
    const m = marketsFromMatrix(M);
    // home_over25 ⊂ home e ⊂ over25
    expect(p.home_over25).toBeLessThanOrEqual(m.home + 1e-9);
    expect(p.home_over25).toBeLessThanOrEqual(m.over25 + 1e-9);
    expect(p.home_over25).toBeGreaterThan(0);
  });

  it('btts_yes_under15 é impossível (0) e não entra na geração', () => {
    const M = scoreMatrix(1.4, 1.2, -0.09, 10);
    const p = compostaProbsFromMatrix(M);
    expect(p.btts_yes_under15).toBe(0);
    expect(isDegenerateComposta('btts_yes_under15')).toBe(true);
    expect(isDegenerateComposta('btts_yes_over15')).toBe(true);
    expect(isDegenerateComposta('btts_no_under15')).toBe(true);
    expect(COMPOSTA_CANDIDATES).not.toContain('btts_yes_under15');
    expect(COMPOSTA_CANDIDATES).toContain('home_over25');
  });
});
