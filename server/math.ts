/**
 * Matemática partilhada do motor: blends normalizados, logit/sigmoid,
 * deslocamento de probabilidades, cadeia de golos e devig por potência.
 * Funções puras, sem estado.
 */

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Média ponderada que normaliza os pesos (ignora pesos <= 0 e NaN). */
export function blend(pairs: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  let weight = 0;
  for (const [value, w] of pairs) {
    if (!Number.isFinite(value) || !Number.isFinite(w) || w <= 0) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

export function logit(p: number, eps = 1e-6): number {
  const q = clamp(p, eps, 1 - eps);
  return Math.log(q / (1 - q));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Afasta (delta > 0) ou aproxima (delta < 0) a probabilidade de 50%. */
export function shift(p: number, delta: number, eps = 1e-6): number {
  return clamp(sigmoid(logit(p, eps) + delta), eps, 1 - eps);
}

export interface GoalChain {
  over15: number;
  over25: number;
  over35: number;
  under25: number;
  under35: number;
}

/** Garante over15 >= over25 >= over35 e unders como complementares. */
export function enforceGoalChain(chain: GoalChain): GoalChain {
  const over35 = clamp(chain.over35, 0.01, 0.95);
  const over25 = clamp(Math.max(chain.over25, over35), 0.02, 0.97);
  const over15 = clamp(Math.max(chain.over15, over25), 0.03, 0.98);
  return {
    over15,
    over25,
    over35,
    under25: clamp(1 - over25, 0.01, 0.98),
    under35: clamp(1 - over35, 0.01, 0.98),
  };
}

/**
 * Remove a margem de um conjunto de odds pelo método da potência:
 * p_i = (1/odd_i)^k, escolhendo k para que sum(p_i) = 1.
 */
export function devigPower(odds: ReadonlyArray<number>, iterations = 40): number[] {
  const valid = odds.map((o) => (Number.isFinite(o) && o > 1.0001 ? o : NaN));
  if (valid.some((o) => Number.isNaN(o))) return [];
  let lo = 0.2;
  let hi = 3;
  const implied = (k: number): number[] => valid.map((o) => Math.pow(1 / o, k));
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const total = implied(mid).reduce((a, b) => a + b, 0);
    if (total > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return implied(k);
}
