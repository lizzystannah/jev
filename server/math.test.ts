import { describe, expect, it } from 'vitest';
import { blend, devigPower, enforceGoalChain, logit, shift, sigmoid } from './math.js';

describe('math', () => {
  it('blend normaliza os pesos', () => {
    expect(blend([[0.5, 1], [1, 3]])).toBeCloseTo(0.875);
    expect(blend([])).toBe(0);
  });

  it('logit/sigmoid são inversos e shift preserva a ordem', () => {
    expect(sigmoid(logit(0.3))).toBeCloseTo(0.3, 6);
    expect(shift(0.5, 1)).toBeGreaterThan(0.5);
    expect(shift(0.5, -1)).toBeLessThan(0.5);
  });

  it('enforceGoalChain garante over15 >= over25 >= over35', () => {
    const chain = enforceGoalChain({
      over15: 0.4,
      over25: 0.7,
      over35: 0.8,
      under25: 0.3,
      under35: 0.2,
    });
    expect(chain.over15).toBeGreaterThanOrEqual(chain.over25);
    expect(chain.over25).toBeGreaterThanOrEqual(chain.over35);
    expect(chain.under25).toBeCloseTo(1 - chain.over25);
    expect(chain.under35).toBeCloseTo(1 - chain.over35);
  });

  it('devigPower remove a margem (soma = 1)', () => {
    const p = devigPower([2.0, 3.5, 4.0]);
    expect(p).toHaveLength(3);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
  });
});
