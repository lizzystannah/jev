import { describe, expect, it } from 'vitest';
import { aiscoreDatesCovering, appDayKey, aiscoreDayKey, appDayStartMs } from './time.js';

const DAY_MS = 86_400_000;

/** 2026-03-18 00:30 em Luanda (UTC+1) = 2026-03-17 23:30 UTC. */
const LUANDA_0030 = Date.parse('2026-03-17T23:30:00Z');
const LUANDA_0359 = Date.parse('2026-03-18T02:59:00Z');
const LUANDA_0401 = Date.parse('2026-03-18T03:01:00Z');

describe('time (fusos unificados)', () => {
  it('o dia do app é o dia de Angola', () => {
    expect(appDayKey(LUANDA_0030)).toBe('2026-03-18');
    expect(appDayKey(LUANDA_0359)).toBe('2026-03-18');
    expect(appDayKey(LUANDA_0401)).toBe('2026-03-18');
  });

  it('a data do AiScore (UTC−3) durante a madrugada é o dia anterior', () => {
    expect(aiscoreDayKey(LUANDA_0030)).toBe('2026-03-17');
    expect(aiscoreDayKey(LUANDA_0359)).toBe('2026-03-17');
    expect(aiscoreDayKey(LUANDA_0401)).toBe('2026-03-18');
  });

  it('aiscoreDatesCovering inclui o dia anterior durante a madrugada', () => {
    const dates = aiscoreDatesCovering(LUANDA_0030, LUANDA_0030 + DAY_MS);
    expect(dates).toContain('20260317');
    expect(dates).toContain('20260318');
  });

  it('aiscoreDatesCovering às 04:01 já não precisa do dia anterior', () => {
    const dates = aiscoreDatesCovering(LUANDA_0401, LUANDA_0401 + DAY_MS);
    expect(dates).toContain('20260318');
  });

  it('appDayStartMs devolve o início do dia em Angola', () => {
    const start = appDayStartMs(LUANDA_0401);
    expect(appDayKey(start)).toBe('2026-03-18');
    expect(start).toBeLessThanOrEqual(LUANDA_0401);
  });
});
