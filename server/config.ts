/**
 * Configuração única do motor de fichas.
 *
 * Este módulo NÃO importa nada do projeto exceto tipos (evita ciclos): só lê
 * variáveis de ambiente, valida invariantes e expõe tudo o que o motor local e
 * o ticketEngine precisam. Os nomes das variáveis são os mesmos de sempre.
 */

import type { SlipTier } from './types.js';

export type EngineTier = SlipTier;

function envNumber(name: string, fb: number, min = -Infinity, max = Infinity): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fb;
}

export const envInt = (name: string, fb: number): number => {
  const n = envNumber(name, NaN, 0);
  return Number.isFinite(n) ? Math.trunc(n) : fb;
};

export const envFloat = (name: string, fb: number): number =>
  envNumber(name, fb, Number.MIN_VALUE);

export function envBool(name: string, fb: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw ? ['1', 'true', 'yes', 'on'].includes(raw) : fb;
}

const MALUCA_MIN = Math.max(1.01, envFloat('TICKETS_MALUCA_MIN_LEG_ODD', 1.75));
const MALUCA_MAX = Math.max(MALUCA_MIN, envFloat('TICKETS_MALUCA_MAX_LEG_ODD', 3.0));

const legMinOdd = Math.max(1.01, envFloat('TICKETS_MIN_LEG_ODD', 1.25));
const legMaxOdd = Math.max(legMinOdd, envFloat('TICKETS_MAX_LEG_ODD', 2.2));

const composta = Object.freeze({
  minLegOdd: Math.max(1.01, envFloat('TICKETS_COMPOSTA_MIN_LEG_ODD', 1.5)),
  maxLegOdd: Math.max(1.01, envFloat('TICKETS_COMPOSTA_MAX_LEG_ODD', 3.5)),
  targetMin: Math.max(1.01, envFloat('TICKETS_COMPOSTA_TARGET_MIN', 5.5)),
  targetMax: Math.max(1.01, envFloat('TICKETS_COMPOSTA_TARGET_MAX', 6.5)),
  minTipProb: Math.min(100, envInt('TICKETS_COMPOSTA_MIN_TIP_PROB', 35)),
  minLegs: Math.max(1, envInt('TICKETS_COMPOSTA_MIN_LEGS', 2)),
  maxLegs: Math.max(1, envInt('TICKETS_COMPOSTA_MAX_LEGS', 4)),
});

const longoMinLegs = Math.max(1, envInt('TICKETS_LONGO_MIN_LEGS', 10));
const longo = Object.freeze({
  minLegs: longoMinLegs,
  maxLegs: Math.max(longoMinLegs, envInt('TICKETS_LONGO_MAX_LEGS', 22)),
  minProb: Math.min(95, envInt('TICKETS_LONGO_MIN_PROB', 55)),
});

const manual = Object.freeze({
  minLegOdd: Math.max(1.01, envFloat('TICKETS_MANUAL_MIN_LEG_ODD', 1.2)),
  maxLegs: Math.max(2, envInt('TICKETS_MANUAL_MAX_LEGS', 60)),
});

const antiCorrelation = Object.freeze({
  maxSlipsPerMatch: Math.max(1, envInt('TICKETS_MAX_SLIPS_PER_MATCH', 2)),
  maxReusedLegs: envInt('TICKETS_MAX_REUSED_LEGS', 8),
});

export const CFG = {
  engineVersion: 'local/aiscore-engine-v5',
  band: {
    lo: 0.55,
    hi: 0.75,
    oddFloor: 1.10,
    /** 0 = a odd/EV nunca influencia a escolha (regra de negócio atual). */
    tieEps: envNumber('AISCORE_TIE_EPS', 0, 0, 0.1),
    /** Sem candidato na faixa: 'maxP' (comportamento v4) ou 'closest' (mais perto da faixa). */
    noBandFallback: (process.env.AISCORE_NO_BAND_FALLBACK === 'closest' ? 'closest' : 'maxP') as
      | 'closest'
      | 'maxP',
  },
  maluca: {
    minLegOdd: MALUCA_MIN,
    maxLegOdd: MALUCA_MAX,
    idealLegOdd: (MALUCA_MIN + MALUCA_MAX) / 2,
    minProb: Math.min(95, envInt('TICKETS_MALUCA_MIN_PROB', 25)),
    fallback: { minP: 0.2, minOdd: 1.5, maxOdd: 3.25 },
  },
  model: {
    rho: -0.09,        // Dixon-Coles
    maxGoals: 10,
    adjustCap: 0.15,   // teto total (log-espaço) dos ajustes sobre λ
    resultCap: 0.20,   // teto dos ajustes sobre p(1) / p(2)
    shrinkK: 8,        // força do prior nas taxas empíricas
    scaleMin: 0.9,     // as taxas empíricas só podem mexer ±10% no λ total
    scaleMax: 1.1,
    empWeight: 0.25,
  },
  flags: {
    // Desligado até o backtest (T2) provar ganho.
    htAdj: envBool('AISCORE_FLAG_HT_ADJ', false),
  },
  /** Lido pelo ticketEngine: jogos com modelBasis === 'market' ficam fora das fichas. */
  excludeMarketOnly: envBool('TICKETS_EXCLUDE_MARKET_ONLY', true),
  log: envBool('AISCORE_LOG', true),
} as const;

export const TICKET_TARGETS = Object.freeze({
  segura: Object.freeze({
    targetOdds: Math.max(1.01, envFloat('TICKETS_TARGET_SEGURA', 3)),
    maxLegs: Math.max(2, envInt('TICKETS_MAX_LEGS_SEGURA', 12)),
    minLegs: 2,
    label: 'Segura',
  }),
  moderada: Object.freeze({
    targetOdds: Math.max(1.01, envFloat('TICKETS_TARGET_MODERADA', 15)),
    maxLegs: Math.max(2, envInt('TICKETS_MAX_LEGS_MODERADA', 18)),
    minLegs: 2,
    label: 'Moderada',
  }),
  ousada: Object.freeze({
    targetOdds: Math.max(1.01, envFloat('TICKETS_TARGET_OUSADA', 100)),
    maxLegs: Math.max(2, envInt('TICKETS_MAX_LEGS_OUSADA', 26)),
    minLegs: 2,
    label: 'Ousada',
  }),
  maluca: Object.freeze({
    targetOdds: Math.max(1.01, envFloat('TICKETS_TARGET_MALUCA', 250)),
    maxLegs: Math.max(1, envInt('TICKETS_MAX_LEGS_MALUCA', 8)),
    minLegs: 4,
    label: 'Maluca',
  }),
  compostas: Object.freeze({
    targetOdds: Math.max(1.01, envFloat('TICKETS_TARGET_COMPOSTAS', 6)),
    maxLegs: composta.maxLegs,
    minLegs: composta.minLegs,
    label: 'Compostas',
  }),
} as const);

const quotas = Object.freeze({
  dia: Math.max(1, envInt('TICKETS_QUOTA_DIA', 5)),
  '2_3_dias': Math.max(1, envInt('TICKETS_QUOTA_MED', 5)),
  longo: Math.max(1, envInt('TICKETS_QUOTA_LONGO', 5)),
} as const);

const maxPending = Object.freeze({
  dia: quotas.dia + envInt('TICKETS_MAX_PENDING_EXTRA_DIA', 2),
  '2_3_dias': quotas['2_3_dias'] + envInt('TICKETS_MAX_PENDING_EXTRA_MED', 2),
  longo: quotas.longo + envInt('TICKETS_MAX_PENDING_EXTRA_LONGO', 2),
} as const);

// ------------------------------------------------------------------ tiers ---

/** Definição única dos tiers por probabilidade calibrada (percentagem). */
export const TIER_BANDS = { segura: 63, moderada: 48, ousada: 28 } as const;

export function tierFromProb(pct: number): Exclude<SlipTier, 'compostas'> {
  return pct >= TIER_BANDS.segura ? 'segura'
    : pct >= TIER_BANDS.moderada ? 'moderada'
    : pct >= TIER_BANDS.ousada ? 'ousada'
    : 'maluca';
}

/** Cores dos tiers; as faixas vêm de TIER_BANDS. */
export const TIERS_CONFIG: Record<
  EngineTier,
  { min: number; max: number; color: string; hex: string }
> = {
  segura: { min: TIER_BANDS.segura, max: 101, color: 'var(--green-tier, #4FAE73)', hex: '#4FAE73' },
  moderada: { min: TIER_BANDS.moderada, max: TIER_BANDS.segura, color: 'var(--amber-tier, #E7B33E)', hex: '#E7B33E' },
  ousada: { min: TIER_BANDS.ousada, max: TIER_BANDS.moderada, color: 'var(--red-tier, #D1594B)', hex: '#D1594B' },
  maluca: { min: 0, max: TIER_BANDS.ousada, color: 'var(--violet-tier, #C084FC)', hex: '#C084FC' },
  compostas: {
    min: 0,
    max: 101,
    color: 'var(--blue-tier, #38BDF8)',
    hex: '#38BDF8',
  },
};

// ------------------------------------------------------------- exportação ---

export const LONGO_MIN_LEGS = longo.minLegs;
export const LONGO_MAX_LEGS = longo.maxLegs;
export const LONGO_MIN_PROB = longo.minProb;
export const MAX_LEG_ODD = legMaxOdd;
export const MIN_LEG_ODD = legMinOdd;
export const MANUAL_MIN_LEG_ODD = manual.minLegOdd;
export const MANUAL_MAX_LEGS = manual.maxLegs;
export const NON_MALUCA_MIN_PROB = Math.min(95, envInt('TICKETS_NON_MALUCA_MIN_PROB', 40));
export const MALUCA_MIN_LEG_ODD = CFG.maluca.minLegOdd;
export const MALUCA_MAX_LEG_ODD = CFG.maluca.maxLegOdd;
export const MALUCA_MIN_PROB = CFG.maluca.minProb;
export const MALUCA_IDEAL_LEG_ODD = CFG.maluca.idealLegOdd;
export const MAX_SLIPS_PER_MATCH = antiCorrelation.maxSlipsPerMatch;
export const MAX_REUSED_LEGS = antiCorrelation.maxReusedLegs;
export const SCOPE_QUOTAS = quotas;
export const SCOPE_MAX_PENDING = maxPending;
export const EXPIRY_GRACE_HOURS = envInt('TICKETS_EXPIRY_GRACE_HOURS', 6);
export const COMPOSTA_MIN_LEG_ODD = composta.minLegOdd;
export const COMPOSTA_MAX_LEG_ODD = composta.maxLegOdd;
export const COMPOSTA_TARGET_MIN = composta.targetMin;
export const COMPOSTA_TARGET_MAX = composta.targetMax;
export const COMPOSTA_MIN_TIP_PROB = composta.minTipProb;
export const COMPOSTA_MAX_LEGS = composta.maxLegs;
export const COMPOSTA_MIN_LEGS = composta.minLegs;
