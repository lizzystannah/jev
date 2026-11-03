import { describe, it, expect } from 'vitest';
import {
  scoreMatrix, marketsFromMatrix, devigPower, blend, fitMatrix,
} from './scoreModel.js';
import { localModel, evaluateOne, callLocalInferenceEngine, teamBlock } from './aiscoreEngine.js';

describe('scoreModel', () => {
  it('matriz soma 1 e Dixon-Coles aumenta empates', () => {
    const dc = marketsFromMatrix(scoreMatrix(1.4, 1.1, -0.09));
    const ind = marketsFromMatrix(scoreMatrix(1.4, 1.1, 0));
    expect(dc.home + dc.draw + dc.away).toBeCloseTo(1, 6);
    expect(dc.draw).toBeGreaterThan(ind.draw);
  });
  it('cadeia de golos é monotónica', () => {
    for (const [a, b] of [[0.6, 0.5], [1.4, 1.1], [3, 2.5]]) {
      const m = marketsFromMatrix(scoreMatrix(a, b));
      expect(m.over15).toBeGreaterThan(m.over25);
      expect(m.over25).toBeGreaterThan(m.over35);
      expect(m.btts_yes).toBeLessThan(m.over15);
    }
  });
  it('blend normaliza e ignora null', () => {
    expect(blend([[0.6, 0.5], [0.28, 0.5], [0, null]])).toBeCloseTo(0.5, 9);
  });
  it('devigPower soma 1', () => {
    const p = devigPower([1.9, 3.6, 4.2]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
  it('fitMatrix bate os marginais 1X2, over 2.5 e BTTS', () => {
    const M = scoreMatrix(1.4, 1.1, -0.09);
    const target = { home: 0.44, draw: 0.29, away: 0.27, over25: 0.55, btts: 0.52 };
    const m = marketsFromMatrix(fitMatrix(M, target, 40));
    expect(m.home + m.draw + m.away).toBeCloseTo(1, 6);
    expect(m.home).toBeCloseTo(target.home, 3);
    expect(m.draw).toBeCloseTo(target.draw, 3);
    expect(m.away).toBeCloseTo(target.away, 3);
    expect(m.over25).toBeCloseTo(target.over25, 3);
    expect(m.btts_yes).toBeCloseTo(target.btts, 3);
  });
});

describe('localModel / evaluateOne', () => {
  const scout = { home_form: { n: 10, GF: 18, GA: 10, form: 'WWDLW' },
    away_form: { n: 10, GF: 12, GA: 14, form: 'LDWLL' } };
  it('under = 1 - over e 1X2 soma 1', () => {
    const { probs: p } = localModel(scout, null);
    expect(p.under25).toBeCloseTo(1 - p.over25, 9);
    expect(p.under35).toBeCloseTo(1 - p.over35, 9);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 6);
    expect(p.over15).toBeGreaterThan(p.over25);
    expect(p.over25).toBeGreaterThan(p.over35);
  });
  it('é determinístico', () => {
    expect(localModel(scout, null).probs).toEqual(localModel(scout, null).probs);
  });
  it('equipa sem dados usa priors em vez de λ=0', () => {
    const { probs: p } = localModel({}, null);
    expect(Number.isFinite(p.over25)).toBe(true);
    expect(p.over25).toBeGreaterThan(0);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 6);
  });
  it('G1: n e golos vêm sempre da mesma fonte (advanced > form)', () => {
    const b = teamBlock(
      { n: 5, GF: 100, GA: 0, W: 5, D: 0, L: 0 },
      null,
      'home',
      { n: 10, GF: 20, GA: 5, W: 6, D: 2, L: 2 }
    );
    expect(b.n).toBe(10);
    expect(b.GF).toBe(20);
    expect(b.GA).toBe(5);
    expect(b.W).toBe(6);
  });
  it('sem scout nem contexto: modelBasis=market e confiança ≤ 0.3', () => {
    const ev = evaluateOne({ id: 'x', league: 'L', home: 'A', away: 'B', daysFromNow: 0,
      odds: { home: 2.1, draw: 3.4, away: 3.6 } as any, context: null });
    expect(ev.modelBasis).toBe('market');
    expect(ev.confidence).toBeLessThanOrEqual(0.3);
  });
  it('sem dados válidos devolve modelBasis=none e não priced', () => {
    const ev = evaluateOne({ id: 'none', league: 'L', home: 'A', away: 'B', daysFromNow: 0,
      odds: { home: 0, draw: 0, away: 0, over25: 0, under25: 0, btts_yes: 0, btts_no: 0 } as any,
      context: null });
    expect(ev.modelBasis).toBe('none');
    expect(ev.priced).toBe(false);
    expect(ev.tips).toEqual([]);
    expect(ev.selectedOdds).toBe(0);
  });
  it('um jogo mau não derruba o lote', async () => {
    const res = await callLocalInferenceEngine({
      scope: 'dia',
      horizonDays: 0,
      matches: [{
        id: 'bad', league: 'L', home: 'A', away: 'B', daysFromNow: 0,
        odds: null as any, context: null,
      }],
    });
    expect(res.evaluations).toHaveLength(1);
    expect(res.evaluations[0].modelBasis).toBe('none');
  });
});
