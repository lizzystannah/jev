export interface Adjustment { key: string; pct: number }

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const LOGFACT: number[] = (() => {
  const t = [0];
  for (let i = 1; i <= 40; i++) t.push(t[i - 1] + Math.log(i));
  return t;
})();

function pmfRow(lam: number, max: number): number[] {
  const l = Math.max(lam, 1e-6);
  const row = new Array<number>(max + 1);
  for (let k = 0; k <= max; k++) row[k] = Math.exp(-l + k * Math.log(l) - LOGFACT[k]);
  return row;
}

/** Correção Dixon-Coles para placares baixos (rho < 0 → mais 0-0 e 1-1). */
function tau(i: number, j: number, lh: number, la: number, rho: number): number {
  if (i === 0 && j === 0) return Math.max(0, 1 - lh * la * rho);
  if (i === 0 && j === 1) return Math.max(0, 1 + lh * rho);
  if (i === 1 && j === 0) return Math.max(0, 1 + la * rho);
  if (i === 1 && j === 1) return Math.max(0, 1 - rho);
  return 1;
}

/** Matriz de placares normalizada: M[golosCasa][golosFora]. */
export function scoreMatrix(lh: number, la: number, rho = -0.09, max = 10): number[][] {
  const mx = Math.min(max, 40);
  const ph = pmfRow(lh, mx);
  const pa = pmfRow(la, mx);
  const M: number[][] = [];
  let sum = 0;
  for (let i = 0; i <= mx; i++) {
    const row: number[] = [];
    for (let j = 0; j <= mx; j++) {
      const v = ph[i] * pa[j] * tau(i, j, lh, la, rho);
      row.push(v);
      sum += v;
    }
    M.push(row);
  }
  for (const row of M) for (let j = 0; j < row.length; j++) row[j] /= sum;
  return M;
}

export function totalAtLeast(M: number[][], n: number): number {
  let p = 0;
  for (let i = 0; i < M.length; i++)
    for (let j = 0; j < M[i].length; j++) if (i + j >= n) p += M[i][j];
  return p;
}

export interface MatrixMarkets {
  home: number; draw: number; away: number;
  over15: number; over25: number; over35: number; btts_yes: number;
}

export function marketsFromMatrix(M: number[][]): MatrixMarkets {
  let home = 0, draw = 0, away = 0, btts = 0;
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      const p = M[i][j];
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  return {
    home, draw, away,
    over15: totalAtLeast(M, 2), over25: totalAtLeast(M, 3), over35: totalAtLeast(M, 4),
    btts_yes: btts,
  };
}

/**
 * Escala (λh, λa) por k ∈ [lo, hi] para que P(over 2.5) se aproxime de `target`.
 * Todos os mercados continuam a sair da MESMA matriz → coerência por construção
 * (over15 ≥ over25 ≥ over35, 1X2 soma 1).
 */
export function fitTotalScale(
  lh: number, la: number, rho: number, target: number, lo = 0.9, hi = 1.1
): number {
  const f = (k: number) => totalAtLeast(scoreMatrix(lh * k, la * k, rho), 3);
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  let a = lo, b = hi;
  for (let it = 0; it < 16; it++) {
    const mid = (a + b) / 2;
    if (f(mid) < target) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

/** Média ponderada com pesos normalizados; ignora componentes null/NaN. */
export function blend(parts: Array<[number, number | null | undefined]>): number {
  let w = 0, s = 0;
  for (const [wi, v] of parts) {
    if (wi > 0 && v != null && Number.isFinite(v)) { w += wi; s += wi * v; }
  }
  return w > 0 ? s / w : NaN;
}

/** Taxa empírica encolhida para um prior (Beta). Com n pequeno ≈ prior. */
export function betaShrink(count: number, n: number, prior: number, k = 8): number {
  return (count + k * prior) / (n + k);
}

export const logit = (p: number) => {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
};
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const shiftLogit = (p: number, d: number) => sigmoid(logit(p) + d);

/**
 * Ajustes multiplicativos combinados em log-espaço com teto total ±cap.
 * Evita que 10 "pequenos" ajustes somem +30%.
 */
export function applyAdjustments(
  base: number, adjs: Adjustment[], cap = 0.15
): { value: number; applied: number } {
  const sum = adjs.reduce((a, x) => a + Math.log1p(clamp(x.pct, -0.95, 5)), 0);
  const c = clamp(sum, Math.log(1 - cap), Math.log(1 + cap));
  return { value: base * Math.exp(c), applied: Math.exp(c) - 1 };
}

/** Remove a margem (método da potência): p_i = q_i^c com Σ p_i = 1. */
export function devigPower(odds: number[]): number[] {
  const q = odds.map((o) => 1 / o);
  const sum = q.reduce((a, b) => a + b, 0);
  if (!(sum > 1)) return q.map((x) => x / sum);
  let lo = 1, hi = 8;
  for (let it = 0; it < 40; it++) {
    const c = (lo + hi) / 2;
    const f = q.reduce((a, x) => a + Math.pow(x, c), 0);
    if (f > 1) lo = c; else hi = c;
  }
  const c = (lo + hi) / 2;
  return q.map((x) => Math.pow(x, c));
}

/**
 * Reajusta a matriz por IPF até os marginais 1X2, over 2.5 e BTTS baterem
 * certo. Mantém as proporções internas da matriz original.
 */
export function fitMatrix(
  M: number[][],
  t: { home: number; draw: number; away: number; over25: number; btts: number },
  iters = 25
): number[][] {
  const R = M.map((r) => [...r]);
  const classes: Array<[(i: number, j: number) => number, number[]]> = [
    [(i, j) => (i > j ? 0 : i === j ? 1 : 2), [t.home, t.draw, t.away]],
    [(i, j) => (i + j >= 3 ? 1 : 0), [1 - t.over25, t.over25]],
    [(i, j) => (i > 0 && j > 0 ? 1 : 0), [1 - t.btts, t.btts]],
  ];
  for (let it = 0; it < iters; it++) {
    for (const [cls, target] of classes) {
      const sums = new Array<number>(target.length).fill(0);
      for (let i = 0; i < R.length; i++)
        for (let j = 0; j < R[i].length; j++) sums[cls(i, j)] += R[i][j];
      for (let i = 0; i < R.length; i++)
        for (let j = 0; j < R[i].length; j++)
          R[i][j] *= target[cls(i, j)] / Math.max(sums[cls(i, j)], 1e-12);
    }
  }
  return R;
}
