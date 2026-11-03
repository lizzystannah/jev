import { describe, expect, it } from 'vitest';
import { CFG, MIN_LEG_ODD, TIER_BANDS, tierFromProb } from './config.js';

describe('config', () => {
  it('piso do motor fica abaixo do mínimo das fichas', () => {
    expect(CFG.band.oddFloor).toBe(1.10);
    expect(MIN_LEG_ODD).toBe(1.25);
    expect(CFG.band.oddFloor).toBeLessThan(MIN_LEG_ODD);
  });

  it('tierFromProb usa as mesmas faixas em todo o motor', () => {
    expect(tierFromProb(63)).toBe('segura');
    expect(tierFromProb(62)).toBe('moderada');
    expect(tierFromProb(48)).toBe('moderada');
    expect(tierFromProb(47)).toBe('ousada');
    expect(tierFromProb(28)).toBe('ousada');
    expect(tierFromProb(27)).toBe('maluca');
  });

  it('faixas são contíguas e ordenadas', () => {
    expect(TIER_BANDS.segura).toBeGreaterThan(TIER_BANDS.moderada);
    expect(TIER_BANDS.moderada).toBeGreaterThan(TIER_BANDS.ousada);
    expect(TIER_BANDS.ousada).toBeGreaterThan(0);
  });
});
