import { describe, expect, it, vi } from 'vitest';

const { runPythonJsonMock } = vi.hoisted(() => ({ runPythonJsonMock: vi.fn() }));

vi.mock('./pythonBridge.js', () => ({
  resolvePythonBin: () => 'python3',
  runPythonJson: runPythonJsonMock,
}));

import { resolvePremierBetOdds } from './premierbetOdds.js';

function result(idx: number, home: string, away: string, odd: number) {
  return {
    idx,
    home,
    away,
    event_id: `ev${idx}`,
    event: `${home} v ${away}`,
    odds: { over25: odd },
    error: null,
  };
}

describe('resolvePremierBetOdds (alinhamento)', () => {
  it('devolve um resultado alinhado por perna (o do meio falta)', async () => {
    runPythonJsonMock.mockResolvedValueOnce({
      ok: true,
      results: [result(0, 'A', 'B', 1.9), result(2, 'C', 'D', 2.1)],
    });
    const res = await resolvePremierBetOdds([
      { home: 'A', away: 'B', markets: ['over25'] },
      { home: 'C', away: 'D', markets: ['over25'] },
      { home: 'E', away: 'F', markets: ['over25'] },
    ]);
    expect(res.aligned).toHaveLength(3);
    expect(res.aligned[0]?.event_id).toBe('ev0');
    expect(res.aligned[1]).toBeNull();
    expect(res.aligned[2]?.event_id).toBe('ev2');
    // `results` sem buracos: só para diagnóstico, NUNCA para indexar.
    expect(res.results).toHaveLength(2);
  });

  it('sem o idx do bridge, associa pelo par de equipas (não pela posição)', async () => {
    runPythonJsonMock.mockResolvedValueOnce({
      ok: true,
      results: [
        { ...result(0, 'Y', 'Z', 3.3), idx: undefined },
        { ...result(1, 'W', 'X', 3.4), idx: undefined },
      ],
    });
    const res = await resolvePremierBetOdds([
      { home: 'W', away: 'X', markets: ['over25'] },
      { home: 'Y', away: 'Z', markets: ['over25'] },
    ]);
    // A posição NÃO pode ser usada: a 2ª perna é o 1º resultado.
    expect(res.aligned[0]?.home).toBe('W');
    expect(res.aligned[0]?.odds.over25).toBe(3.4);
    expect(res.aligned[1]?.home).toBe('Y');
    expect(res.aligned[1]?.odds.over25).toBe(3.3);
  });

  it('uma falha numa perna não desloca as odds das seguintes', async () => {
    runPythonJsonMock.mockResolvedValueOnce({
      ok: true,
      results: [result(0, 'M1', 'N1', 1.5)],
    });
    const res = await resolvePremierBetOdds([
      { home: 'M1', away: 'N1', markets: ['over25'] },
      { home: 'M2', away: 'N2', markets: ['over25'] },
    ]);
    expect(res.aligned[0]?.odds.over25).toBe(1.5);
    expect(res.aligned[1]).toBeNull();
  });
});
