/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Motor probabilístico LOCAL (substitui o Jev/OpenRouter).
 * Variáveis usadas: ver comentário v4 (scout + advanced + tabelas + escalações).
 *
 * v5:
 *  - Uma única matriz de placares (Poisson + Dixon-Coles) → todos os mercados coerentes.
 *  - Taxas empíricas e H2H só escalam λ total (±10%); sem dupla contagem.
 *  - Ajustes contextuais em log-espaço com teto total.
 *  - Pesos do blend normalizados.
 *  - Sem scout: leitura de mercado SEM margem, só com preços reais, marcada
 *    modelBasis='market' e confiança ≤ 0.3.
 *
 * Seleção da tip: por FAIXA de probabilidade [0.55, 0.75], piso de odd 1.10.
 * A odd de mercado só serve para o piso e para REPORTAR EV; nunca decide.
 * Determinístico, síncrono, sem rede, sem LLM.
 *
 * ATENÇÃO: já NÃO é port fiel do motor_aiscore.py. Se precisas de paridade
 * com o Python, a divergência é intencional a partir da v5.
 */

import type { MarketType, MatchOdds, MatchTip, SimpleMarket, SlipScope, SlipTier, TipOption } from './types.js';
import { deriveCompleteOdds, labelForMarket } from './marketService.js';
import { compostaProbsFromMatrix, isCompostaMarket } from './compostas.js';
import { CFG, tierFromProb } from './config.js';
import {
  type Adjustment, applyAdjustments, betaShrink, blend, devigPower,
  fitMatrix, fitTotalScale, marketsFromMatrix, scoreMatrix, shiftLogit,
} from './scoreModel.js';

export const AISCORE_ENGINE_VERSION = 'local/aiscore-engine-v5';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

let nanFallbacks = 0;

export interface LocalDecisionInput {
  scope: SlipScope;
  horizonDays: number;
  matches: Array<{
    id: string;
    league: string;
    home: string;
    away: string;
    daysFromNow: number;
    odds: MatchOdds;
    context: unknown;
    scout?: any;
    advanced?: any;
    tables?: any;
    lineups?: any;
    /** Quando definido, a tip recomendada passa a ser ESTE mercado. */
    forcedMarket?: MarketType;
  }>;
}

export interface LocalEvaluatedMatch {
  matchId: string;
  calibratedProb: number;
  calibratedP: number;
  expectedValueEdge: number;
  recommendedMarket: MarketType;
  marketLabel: string;
  selectedOdds: number;
  riskTier: SlipTier;
  highRiskTip?: MatchTip;
  tips: TipOption[];
  confidence: number;
  /** 'market' = sem scout; 'none' = sem dados suficientes. */
  modelBasis: 'model' | 'market' | 'none';
  /** true quando a tip escolhida tem odd real acima do piso. */
  priced: boolean;
  /** true quando o mercado forçado foi realmente aplicado. */
  forcedApplied: boolean;
}

export interface LocalInferenceResponse {
  modelVersion: string;
  latencyMs: number;
  scope: SlipScope;
  provider: 'local';
  evaluations: LocalEvaluatedMatch[];
}

// ---------------------------------------------------------------- helpers ---

function num(v: unknown, fb = 0): number {
  const f = Number(v);
  return Number.isFinite(f) ? f : fb;
}

function formPoints(form: string): [number, number] {
  if (!form) return [0, 0];
  const w: Record<string, number> = { W: 3, D: 1, L: 0 };
  let tot = 0;
  let pw = 0;
  const f = form.trim().toUpperCase();
  for (let k = 0; k < f.length; k++) {
    const ch = f[f.length - 1 - k]; // k=0 mais recente
    const decay = 1 / (1 + 0.25 * k);
    tot += (w[ch] ?? 0) * decay;
    pw += 3 * decay;
  }
  return [pw ? tot / pw : 0, f.length];
}

function streakBonus(form: string): number {
  if (!form) return 0;
  const f = form.trim().toUpperCase();
  const last = f.slice(-3);
  let s = 0;
  for (const c of last) s += c === 'W' ? 1 : c === 'D' ? 0.3 : c === 'L' ? -0.7 : 0;
  return clamp(s / 3, -1, 1) * 0.12;
}

function sanitizeOdd(v: unknown, fb = 1.85): number {
  const f = Number(v);
  if (!Number.isFinite(f) || f <= 1.01) return fb;
  return Number(f.toFixed(2));
}

// --------------------------------------------------------------- blocos ---

interface TeamBlock {
  n: number; W: number; D: number; L: number; GF: number; GA: number;
  form: string; venueN: number; venueGf: number; venueGa: number;
  venueW: number; venueD: number; venueL: number;
  avg1h: number | null;
  cleanSheets: number; failedToScore: number;
  over25Rate: number; bttsRate: number;
  poss: number; shots: number; unbeaten: number;
  underCards: number; underCorners: number; trendMatches: number;
}

function deriveFromMatches(matches: any, venueSide: 'home' | 'away') {
  // O scout_one não traz over25/btts/clean-sheets/GF-GA-de-mando agregados —
  // deriva-se da mesma fonte: os ~10 jogos finalizados (ft/ht/gf/ga/side).
  const fin: any[] = Array.isArray(matches) ? matches.filter(
    (r) => r && r.finished && r.ft_home != null && r.ft_away != null) : [];
  const n = fin.length;
  const totals = fin.map((r) => num(r.ft_home) + num(r.ft_away));
  const ht = fin.filter((r) => r.ht_home != null && r.ht_away != null)
    .map((r) => num(r.ht_home) + num(r.ht_away));
  const v = fin.filter((r) => r.side === venueSide);
  return {
    n,
    GF: fin.reduce((a, r) => a + num(r.gf), 0),
    GA: fin.reduce((a, r) => a + num(r.ga), 0),
    W: fin.filter((r) => r.result === 'W').length,
    D: fin.filter((r) => r.result === 'D').length,
    L: fin.filter((r) => r.result === 'L').length,
    over25Rate: n ? totals.filter((t) => t >= 3).length / n : 0.5,
    bttsRate: n ? fin.filter((r) => num(r.ft_home) > 0 && num(r.ft_away) > 0).length / n : 0.4,
    cleanSheets: fin.filter((r) => num(r.ga) === 0).length,
    failedToScore: fin.filter((r) => num(r.gf) === 0).length,
    avg1h: ht.length ? ht.reduce((a, b) => a + b, 0) / ht.length : null as number | null,
    venueN: v.length,
    venueGf: v.reduce((a, r) => a + num(r.gf), 0),
    venueGa: v.reduce((a, r) => a + num(r.ga), 0),
    venueW: v.filter((r) => r.result === 'W').length,
    venueD: v.filter((r) => r.result === 'D').length,
    venueL: v.filter((r) => r.result === 'L').length,
  };
}

function aggRate(A: any, F: any, key: string): number | null {
  for (const src of [A?.[key], F?.[key]]) {
    if (src && typeof src === 'object' && num(src.n) > 0) {
      return num(src.count) / num(src.n, 1);
    }
  }
  return null;
}

export function teamBlock(form: any, trend: any, venueSide: 'home' | 'away', advLast10?: any): TeamBlock {
  // Precedência: advanced team_stats last10 (mais rico) > agregados do form >
  // derivado da lista de jogos. venueSide: 'home' p/ mandante, 'away' p/ visitante.
  const F = form || {};
  const t = trend || {};
  const A = advLast10 || {};
  const der = deriveFromMatches(F.matches || A.matches, venueSide);

  // G1: n, golos e W/D/L têm de vir da MESMA fonte. Preferimos advanced
  // (10 jogos), depois o agregado do form; só no fim derivamos da lista.
  const S = [A, F].find((s) => num(s?.n) > 0 && s?.GF != null && s?.GA != null);
  const n = S ? num(S.n) : der.n;
  const GF = S ? num(S.GF) : der.GF;
  const GA = S ? num(S.GA) : der.GA;
  const W = S ? num(S.W) : der.W;
  const D = S ? num(S.D) : der.D;
  const L = S ? num(S.L) : der.L;

  const vAdv = (A.venue || {})[venueSide] || {};
  const vSco = F[venueSide] || {};
  const V = [vAdv, vSco].find((v) => num(v?.n) > 0 && v?.GF != null && v?.GA != null);
  const venueN = V ? num(V.n) : der.venueN;
  const venueGf = V ? num(V.GF) : der.venueGf;
  const venueGa = V ? num(V.GA) : der.venueGa;
  const venueW = V ? num(V.W) : der.venueW;
  const venueD = V ? num(V.D) : der.venueD;
  const venueL = V ? num(V.L) : der.venueL;

  const o25 = aggRate(A, F, 'over25') ?? der.over25Rate;
  const bt = aggRate(A, F, 'btts') ?? der.bttsRate;
  const cs = A.clean_sheets ?? F.clean_sheets ?? der.cleanSheets;
  const fts = A.failed_to_score ?? F.failed_to_score ?? der.failedToScore;
  const avg1h = A.avg_1h_goals ?? F.avg_1h_goals ?? der.avg1h;
  return {
    n, W, D, L, GF, GA,
    form: String(A.form_last10 ?? F.form ?? ''),
    venueN, venueGf, venueGa, venueW, venueD, venueL,
    avg1h: typeof avg1h === 'number' ? avg1h : null,
    cleanSheets: num(cs),
    failedToScore: num(fts),
    over25Rate: o25, bttsRate: bt,
    poss: num(t.avgPossession), shots: parseFloat(t.avgShots) || 0,
    unbeaten: num(t.unbeatenRun),
    underCards: num(t.underCards), underCorners: num(t.underCorners),
    trendMatches: num(t.matches),
  };
}

interface H2HBlock { n: number; W: number; D: number; L: number;
  avgTotal: number; recentAvg: number; over25Rate: number; bttsRate: number;
  unbeatenLongest: number; }

function h2hBlock(scout: any, advanced: any): H2HBlock {
  const rows: any[] = Array.isArray(scout?.h2h) ? scout.h2h : [];
  const fin = rows.filter((r) => r && r.finished && r.ft_home != null && r.ft_away != null);
  const summ = scout?.h2h_summary || {};
  const totals = fin.map((r) => num(r.ft_home) + num(r.ft_away));
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 2.5;
  const recent = fin.slice(0, 3);
  const recAvg = recent.length
    ? recent.reduce((a, r) => a + num(r.ft_home) + num(r.ft_away), 0) / recent.length
    : avg;
  const n = fin.length;
  const btts = fin.filter((r) => num(r.ft_home) > 0 && num(r.ft_away) > 0).length;
  const adv = advanced || {};
  const hs = adv.h2h_stats || adv.h2h || {};
  return {
    n, W: num(summ.W), D: num(summ.D), L: num(summ.L),
    avgTotal: avg, recentAvg: recAvg,
    over25Rate: n ? totals.filter((t) => t >= 3).length / n : avg / 5,
    bttsRate: n ? btts / n : 0.3,
    unbeatenLongest: num(hs.focal_unbeaten_run_longest),
  };
}

// ----------------------------------------------------------------- núcleo ---

export interface EngineExtra {
  tables?: any;
  lineups?: any;
  context?: any;
}

function tableRows(tables: any): any[] {
  const t = tables && typeof tables === 'object'
    ? (tables.tables || tables.rows || []) : [];
  if (!Array.isArray(t)) return [];
  const rows: any[] = [];
  for (const x of t) {
    if (x && typeof x === 'object' && Array.isArray((x as any).rows)) rows.push(...(x as any).rows);
    else if (x && typeof x === 'object' && ((x as any).team_id || (x as any).teamId)) rows.push(x);
  }
  return rows;
}

function teamKey(v: any): string {
  return v == null ? '' : String(v).trim();
}

function normTeamName(v: any): string {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TableInfo {
  pos: number;
  played: number;
  points: number;
  groupSize: number;
  tableKey: string;
}

function tableInfo(row: any, rows: any[]): TableInfo | null {
  if (!row) return null;
  const pos = num(row.position, 0);
  if (!pos) return null;
  const tableKey = teamKey(
    row.table_id ?? row.tableId ?? row.group ?? row.table ?? ''
  );
  const groupSize = tableKey
    ? rows.filter((r) => teamKey(r.table_id ?? r.tableId ?? r.group ?? r.table) === tableKey).length
    : rows.length;
  return {
    pos,
    played: num(row.total, 0),
    points: num(row.points, 0),
    groupSize: Math.max(groupSize, pos),
    tableKey,
  };
}

/**
 * Motivacao por posicao: lideres/topo e equipas na luta pela permanencia
 * ganham peso no fim da epoca; equipas de meio-tabela sem objetivo perdem
 * um pouco. Devolve um score pequeno; o ajuste final e limitado a +-4%.
 */
function motivationScore(info: TableInfo | null): number {
  if (!info || info.groupSize < 8) return 0; // grupos/mini-ligas: sem motivação
  const n = info.groupSize;
  const progress = info.played / Math.max(1, (n - 1) * 2);
  const late = progress >= 0.55;
  let score = 0;
  if (info.pos <= 3) score += 1;
  if (info.pos >= n - 2) score += 0.9;
  if (late && info.pos <= Math.max(4, Math.ceil(n * 0.2))) score += 0.6;
  if (late && info.pos >= Math.max(4, n - 3)) score += 0.7;
  if (late && info.pos > Math.ceil(n * 0.25) && info.pos < n - 4) score -= 0.2;
  return score;
}

function lineupSide(lineups: any, side: 'home' | 'away'): {
  avg: number | null; captainOut: boolean; unavailable: string[]; starters: number } {
  const b = (lineups || {})[side] || {};
  return {
    avg: typeof b.avg_rating === 'number' ? b.avg_rating : null,
    captainOut: b.captain_in_xi === false && num(b.starters) >= 11,
    unavailable: Array.isArray(b.unavailable) ? b.unavailable.map((u: any) => String(u?.position || '?')) : [],
    starters: num(b.starters),
  };
}

/** Peso por posição: F/M tira golos próprios; D/G dá golos ao adversário. */
function posHit(positions: string[]): [number, number] {
  let own = 0, opp = 0;
  for (const p of positions) {
    const pos = (p || '').toUpperCase();
    if (pos === 'F') own += 0.03;
    else if (pos === 'M') own += 0.02;
    else if (pos === 'D') opp += 0.025;
    else if (pos === 'G') opp += 0.04;
    else own += 0.02;
  }
  return [Math.min(0.10, own), Math.min(0.10, opp)];
}

function findTeamRows(scout: any, ctx: any, trows: any[]): { rh: any | null; ra: any | null } {
  const ids = (...v: any[]) => new Set(v.map(teamKey).filter(Boolean));
  const names = (...v: any[]) => new Set(v.map(normTeamName).filter(Boolean));
  const homeIds = ids(scout?.home?.id, scout?.home_team_id, ctx.homeTeamId, ctx.home_team_id, ctx.home?.id);
  const awayIds = ids(scout?.away?.id, scout?.away_team_id, ctx.awayTeamId, ctx.away_team_id, ctx.away?.id);
  const homeNames = names(scout?.home?.name, scout?.home_team, ctx.homeTeam, ctx.home);
  const awayNames = names(scout?.away?.name, scout?.away_team, ctx.awayTeam, ctx.away);
  const find = (idSet: Set<string>, nameSet: Set<string>) => {
    for (const r of trows) {
      const id = teamKey(r?.team_id ?? r?.teamId ?? r?.id);
      if (id && idSet.has(id)) return r;
    }
    for (const r of trows) if (nameSet.has(normTeamName(r?.team))) return r;
    return null;
  };
  return { rh: find(homeIds, homeNames), ra: find(awayIds, awayNames) };
}

function tableStrength(r: any): number | null {
  const tot = num(r?.total);
  if (!tot || tot < 3 || r?.points == null) return null;
  const gd = num(r?.goalDiff);
  return (num(r.points) / tot) / 3 * 0.7 + clamp(gd / tot / 2, -1, 1) * 0.3;
}

interface XgResult {
  xgH: number; xgA: number;
  H: TeamBlock; A: TeamBlock; H2: H2HBlock;
  htAdj: number;
  explain: { home: Adjustment[]; away: Adjustment[] };
}

function estimateXg(scout: any, advanced: any, extra?: EngineExtra): XgResult {
  const adv = { ...(advanced || {}), ...(scout?.advanced || {}) };
  const ex: EngineExtra = { ...(extra || {}) };
  if (ex.tables == null && adv.tables != null) ex.tables = adv.tables;
  if (ex.lineups == null && adv.lineups != null) ex.lineups = adv.lineups;
  if (ex.context == null && adv.context != null) ex.context = adv.context;

  const hs = adv.home_stats || adv.home?.stats || {};
  const as_ = adv.away_stats || adv.away?.stats || {};
  const H = teamBlock(scout?.home_form, scout?.home_trend, 'home', hs.last10);
  const A = teamBlock(scout?.away_form, scout?.away_trend, 'away', as_.last10);
  const H2 = h2hBlock(scout, adv);

  // G2: equipa sem dados não vale 0 golos. Priors provisórios até M2.
  const LG = { homeGf: 1.45, awayGf: 1.15 };
  const perGame = (b: TeamBlock, side: 'home' | 'away'): [number, number] => {
    if (b.n <= 0) {
      return side === 'home' ? [LG.homeGf, LG.awayGf] : [LG.awayGf, LG.homeGf];
    }
    const n = Math.max(1, b.n || 1);
    if (b.venueN >= 2) {
      return [0.55 * (b.venueGf / b.venueN) + 0.45 * (b.GF / n),
        0.55 * (b.venueGa / b.venueN) + 0.45 * (b.GA / n)];
    }
    return [b.GF / n, b.GA / n];
  };
  const [hGf, hGa] = perGame(H, 'home');
  const [aGf, aGa] = perGame(A, 'away');

  // Base. H2H deixou de entrar aqui (entra uma só vez, no alvo de over 2.5/BTTS).
  let xgH = (hGf + aGa) / 2;
  let xgA = (aGf + hGa) / 2;

  // Segunda amostra _sc: regularizador suave, aplicado à base.
  const hts = scout?.home_trend_sc || adv?.home_trend_sc;
  const ats = scout?.away_trend_sc || adv?.away_trend_sc;
  if (num(hts?.matches) > 0) xgH = 0.9 * xgH + 0.1 * (num(hts.goals) / num(hts.matches) + aGa) / 2;
  if (num(ats?.matches) > 0) xgA = 0.9 * xgA + 0.1 * (num(ats.goals) / num(ats.matches) + hGa) / 2;

  // Ajustes: recolhidos e combinados no fim, em log-espaço, com teto.
  const adjH: Adjustment[] = [];
  const adjA: Adjustment[] = [];
  const sym = (key: string, x: number) => {
    if (!x) return;
    adjH.push({ key, pct: x });
    adjA.push({ key, pct: -x });
  };

  adjH.push({ key: 'momentum', pct: streakBonus(H.form) + Math.min(0.06, 0.02 * (H.unbeaten || 0)) });
  adjA.push({ key: 'momentum', pct: streakBonus(A.form) + Math.min(0.06, 0.02 * (A.unbeaten || 0)) });
  sym('remates', clamp(((H.shots || 0) - (A.shots || 0)) / 10, -0.08, 0.08));
  adjH.push({ key: 'residuo_mando', pct: 0.03 });

  const venueEdge = (b: TeamBlock): number => {
    if (!b.venueN || b.venueN < 2) return 0;
    const vwr = b.venueW / Math.max(1, b.venueN);
    const owr = b.W / Math.max(1, b.n || 1);
    return clamp((vwr - owr) * 0.3, -0.05, 0.05);
  };
  adjH.push({ key: 'mando_vitorias', pct: venueEdge(H) });
  adjA.push({ key: 'mando_vitorias', pct: venueEdge(A) });

  const trows = tableRows(ex.tables);
  if (trows.length) {
    const { rh, ra } = findTeamRows(scout, ex.context || {}, trows);
    const sH = rh ? tableStrength(rh) : null;
    const sA = ra ? tableStrength(ra) : null;
    if (sH != null && sA != null) sym('tabela_ppg', clamp((sH - sA) * 0.12, -0.06, 0.06));

    const tiH = tableInfo(rh, trows);
    const tiA = tableInfo(ra, trows);
    if (tiH && tiA) {
      const n = Math.max(tiH.groupSize, tiA.groupSize, 1);
      const posAdj = clamp(((tiA.pos - tiH.pos) / Math.max(1, n - 1)) * 0.02, -0.02, 0.02);
      const motAdj = clamp((motivationScore(tiH) - motivationScore(tiA)) * 0.01, -0.02, 0.02);
      sym('posicao_motivacao', clamp(posAdj + motAdj, -0.04, 0.04));
    }
  }

  const lin = ex.lineups;
  if (lin && typeof lin === 'object' && lin.available) {
    const lh = lineupSide(lin, 'home');
    const la = lineupSide(lin, 'away');
    if (lh.avg != null && la.avg != null) sym('rating_titulares', clamp((lh.avg - la.avg) * 0.04, -0.04, 0.04));
    if (lh.captainOut) adjH.push({ key: 'capitao_fora', pct: -0.02 });
    if (la.captainOut) adjA.push({ key: 'capitao_fora', pct: -0.02 });
    const [ownH, oppH] = posHit(lh.unavailable);
    const [ownA, oppA] = posHit(la.unavailable);
    if (ownH || oppA) adjH.push({ key: 'desfalques', pct: (1 - ownH) * (1 + oppA) - 1 });
    if (ownA || oppH) adjA.push({ key: 'desfalques', pct: (1 - ownA) * (1 + oppH) - 1 });
  }

  const ctx = ex.context || {};
  if (typeof ctx.restDaysHome === 'number' && typeof ctx.restDaysAway === 'number') {
    sym('descanso', clamp((ctx.restDaysHome - ctx.restDaysAway) * 0.008, -0.04, 0.04));
  }

  let htAdj = 0;
  if (H.avg1h != null && A.avg1h != null) {
    htAdj = clamp((H.avg1h + A.avg1h - 1.1) * 0.05, -0.03, 0.03);
  }

  xgH = applyAdjustments(xgH, adjH, CFG.model.adjustCap).value;
  xgA = applyAdjustments(xgA, adjA, CFG.model.adjustCap).value;
  const fin = (x: number, fb: number, side: 'xgH' | 'xgA') => {
    if (!Number.isFinite(x) || x <= 0) {
      nanFallbacks++;
      console.warn(`[AiScore] ${side} inválido; a usar fallback ${fb}`);
      return fb;
    }
    return x;
  };

  return {
    xgH: clamp(fin(xgH, 1.2, 'xgH'), 0.05, 4.5),
    xgA: clamp(fin(xgA, 1.0, 'xgA'), 0.05, 4.5),
    H, A, H2, htAdj,
    explain: { home: adjH.filter((a) => a.pct), away: adjA.filter((a) => a.pct) },
  };
}

export interface LocalModelOutput {
  probs: Record<MarketType, number>;
  xgH: number;
  xgA: number;
  scale: number;
  explain: {
    home: Adjustment[]; away: Adjustment[];
    overShifts: Array<{ key: string; logit: number }>;
  };
}

/** Média das taxas das duas equipas, cada uma encolhida para o prior. */
function pairRate(rH: number, nH: number, rA: number, nA: number, prior: number, k: number): number {
  return (betaShrink(rH * nH, nH, prior, k) + betaShrink(rA * nA, nA, prior, k)) / 2;
}

export function localModel(scout: any, advanced: any, extra?: EngineExtra): LocalModelOutput {
  const x = estimateXg(scout, advanced, extra);
  const { H, A, H2 } = x;
  const ctx = extra?.context || (advanced || {}).context || {};
  const { rho, shrinkK, scaleMin, scaleMax, empWeight, resultCap } = CFG.model;

  const base = marketsFromMatrix(scoreMatrix(x.xgH, x.xgA, rho, CFG.model.maxGoals));
  const h2hW = H2.n >= 2 ? Math.min(0.12, 0.03 * H2.n) : 0;
  const modelW = 1 - empWeight;

  const empO25 = pairRate(H.over25Rate, H.n, A.over25Rate, A.n, base.over25, shrinkK);
  const empBtts = pairRate(H.bttsRate, H.n, A.bttsRate, A.n, base.btts_yes, shrinkK);

  // Deslocamentos em logit sobre o alvo de over 2.5.
  const overShifts: Array<{ key: string; logit: number }> = [];
  const underGame = (Math.min(1, (H.underCards + H.underCorners) / 20)
    + Math.min(1, (A.underCards + A.underCorners) / 20)) / 2;
  if (underGame > 0.85) overShifts.push({ key: 'jogo_travado', logit: -0.07 });
  const closed = ctx.importance === 'derby' || ctx.importance === 'decisiva';
  if (closed) overShifts.push({ key: 'jogo_fechado', logit: -0.09 });
  if (CFG.flags.htAdj && x.htAdj) overShifts.push({ key: 'ritmo_1a_parte', logit: 4 * x.htAdj });

  const tgtO25 = shiftLogit(
    blend([[modelW, base.over25], [empWeight, empO25], [h2hW, H2.over25Rate]]),
    overShifts.reduce((a, s) => a + s.logit, 0)
  );
  const scale = fitTotalScale(x.xgH, x.xgA, rho, tgtO25, scaleMin, scaleMax);
  const lh = x.xgH * scale;
  const la = x.xgA * scale;
  const M = scoreMatrix(lh, la, rho, CFG.model.maxGoals);
  const mk = marketsFromMatrix(M);

  // BTTS: mesmo tratamento; limitado por over15 (BTTS implica ≥ 2 golos).
  let btts = blend([[modelW, mk.btts_yes], [empWeight, empBtts], [h2hW, H2.bttsRate]]);
  if (closed) btts = shiftLogit(btts, -0.06);
  btts = clamp(btts, 0.02, Math.min(0.95, mk.over15 - 0.01));

  // 1X2: forma e H2H como ajustes em log-espaço com teto.
  const [pfH] = formPoints(H.form);
  const [pfA] = formPoints(A.form);
  const formEdge = clamp((pfH - pfA) * 0.35, -0.12, 0.12);
  let h2hEdge = 0;
  const totH2 = H2.W + H2.D + H2.L;
  if (totH2 >= 2) h2hEdge = clamp(((H2.W + 0.5 * H2.D) / totH2 - 0.5) * 0.5, -0.1, 0.1);
  if (H2.unbeatenLongest >= 3 && totH2 >= 2) {
    h2hEdge = clamp(h2hEdge + Math.min(0.05, 0.015 * (H2.unbeatenLongest - 2)), -0.1, 0.1);
  }
  let pH = clamp(applyAdjustments(mk.home,
    [{ key: 'forma', pct: formEdge }, { key: 'h2h', pct: h2hEdge }], resultCap).value, 0.02, 0.93);
  let pA = clamp(applyAdjustments(mk.away,
    [{ key: 'forma', pct: -formEdge }, { key: 'h2h', pct: -h2hEdge }], resultCap).value, 0.02, 0.93);
  const s = pH + mk.draw + pA;
  pH /= s; pA /= s;
  const pD = mk.draw / s;

  // V6: a matriz final tem de respeitar 1X2, over 2.5 e BTTS ao mesmo tempo.
  // IPF reescala as células; todos os mercados (incluindo compostas) saem de F.
  const F = fitMatrix(M, { home: pH, draw: pD, away: pA, over25: tgtO25, btts });
  const fm = marketsFromMatrix(F);

  const o15 = clamp(fm.over15, 0.01, 0.99);
  const o25 = clamp(fm.over25, 0.01, 0.99);
  const o35 = clamp(fm.over35, 0.01, 0.99);
  const bttsFinal = clamp(fm.btts_yes, 0.02, 0.95);

  const probs: Record<string, number> = {
    home: fm.home, draw: fm.draw, away: fm.away,
    double_chance_1x: 1 - fm.away, double_chance_x2: 1 - fm.home, double_chance_12: 1 - fm.draw,
    over15: o15, over25: o25, over35: o35,
    under25: 1 - o25, under35: 1 - o35,
    btts_yes: bttsFinal, btts_no: 1 - bttsFinal,
    dnb_home: clamp(fm.home / Math.max(0.05, fm.home + fm.away), 0.05, 0.97),
    dnb_away: clamp(fm.away / Math.max(0.05, fm.home + fm.away), 0.05, 0.97),
  };
  Object.assign(probs, compostaProbsFromMatrix(F));

  return {
    probs: probs as Record<MarketType, number>,
    xgH: lh, xgA: la, scale,
    explain: { home: x.explain.home, away: x.explain.away, overShifts },
  };
}

/** Compatibilidade com o código existente. */
export function localProbabilities(
  scout: any, advanced: any, extra?: EngineExtra
): Record<MarketType, number> {
  return localModel(scout, advanced, extra).probs;
}

function essentialsFromContext(ctx: any): any {
  // Fallback quando o scout completo ainda não foi anexado: reconstrói um
  // scout mínimo a partir do MatchContext reduzido (recentForm/gols/H2H).
  // G8: não inventar golos, taxas, cartões ou posse quando não há dados.
  if (!ctx || typeof ctx !== 'object') return null;
  const mk = (tf: any) => {
    const rf: string[] = Array.isArray(tf?.recentForm) ? tf.recentForm : [];
    if (!rf.length) return null;
    const n = rf.length;
    const gf = Number(tf?.goalsScoredAvg5);
    const ga = Number(tf?.goalsConcededAvg5);
    const csPct = Number(tf?.cleanSheetPct);
    const W = rf.filter((r) => r === 'W').length;
    const D = rf.filter((r) => r === 'D').length;
    const L = rf.filter((r) => r === 'L').length;
    const out: Record<string, unknown> = {
      n, W, D, L,
      // recentForm já vem do mais antigo para o mais recente (toTeamForm),
      // a mesma convenção de formPoints/streakBonus.
      form: rf.join(''),
    };
    if (Number.isFinite(gf)) out.GF = +(gf * n).toFixed(1);
    if (Number.isFinite(ga)) out.GA = +(ga * n).toFixed(1);
    if (Number.isFinite(csPct)) out.clean_sheets = Math.round((n * csPct) / 100);
    return out;
  };
  const homeForm = mk(ctx.homeForm);
  const awayForm = mk(ctx.awayForm);
  const h2h = ctx.h2h || {};
  const total = num(h2h.homeWins) + num(h2h.draws) + num(h2h.awayWins);
  if (!homeForm && !awayForm && total === 0) return null;
  return {
    home_form: homeForm,
    away_form: awayForm,
    h2h: [],
    h2h_summary: total > 0
      ? { W: num(h2h.homeWins), D: num(h2h.draws), L: num(h2h.awayWins) }
      : undefined,
    _fromContext: true,
  };
}

// ---------------------------------------------------------- fallback/tips ---

/**
 * Sem scout: p vem das odds REAIS sem margem. Mercados sem preço real
 * ficam de fora (nada de constantes inventadas como 0.75 ou 0.3).
 */
function marketOnlyProbs(
  compOdds: Record<string, number>, real?: readonly string[]
): Record<string, number> {
  const o1 = [compOdds.home, compOdds.draw, compOdds.away];
  if (!o1.every((o) => Number.isFinite(o) && o > 1.01)) return {};
  const [pH, pD, pA] = devigPower(o1);
  const P: Record<string, number> = {
    home: pH, draw: pD, away: pA,
    double_chance_1x: pH + pD, double_chance_x2: pD + pA, double_chance_12: pH + pA,
    dnb_home: pH / (pH + pA), dnb_away: pA / (pH + pA),
  };
  const twoWay = (yes: string, no: string) => {
    if (!real?.includes(yes) || !real.includes(no)) return;
    const a = compOdds[yes], b = compOdds[no];
    if (!(a > 1.01 && b > 1.01)) return;
    const [py, pn] = devigPower([a, b]);
    P[yes] = py; P[no] = pn;
  };
  twoWay('over25', 'under25');
  twoWay('btts_yes', 'btts_no');
  twoWay('over35', 'under35');
  return P;
}

interface Cand { m: MarketType; p: number; odd: number }

/** Maior p dentro da faixa; sem candidato na faixa segue CFG.band.noBandFallback. */
function pickInBand(cands: Cand[]): Cand | undefined {
  if (!cands.length) return undefined;
  const { lo, hi, tieEps, noBandFallback } = CFG.band;
  const inBand = cands.filter((x) => x.p >= lo && x.p <= hi);
  if (inBand.length) {
    const best = Math.max(...inBand.map((x) => x.p));
    // tieEps = 0 (defeito): só empates exatos desempatam por EV → a odd nunca decide.
    return inBand
      .filter((x) => best - x.p <= tieEps)
      .sort((a, b) => b.p * b.odd - a.p * a.odd || b.p - a.p)[0];
  }
  if (noBandFallback === 'closest') {
    const dist = (x: Cand) => (x.p < lo ? lo - x.p : x.p - hi);
    return [...cands].sort((a, b) => dist(a) - dist(b) || b.p - a.p)[0];
  }
  return [...cands].sort((a, b) => b.p - a.p)[0];
}

function noDataEvaluation(matchId: string): LocalEvaluatedMatch {
  return {
    matchId, calibratedProb: 0, calibratedP: 0, expectedValueEdge: 0,
    recommendedMarket: 'home', marketLabel: '', selectedOdds: 0,
    riskTier: 'maluca', tips: [], confidence: 0,
    modelBasis: 'none', priced: false, forcedApplied: false,
  };
}

export function evaluateOne(match: LocalDecisionInput['matches'][number]): LocalEvaluatedMatch {
  const compOdds = deriveCompleteOdds(match.odds);
  const realMarkets = match.odds.realMarkets;
  const scout = match.scout || essentialsFromContext(match.context);
  const advanced = match.advanced || match.scout?.advanced || null;
  const extra: EngineExtra = {
    tables: match.tables ?? null,
    lineups: match.lineups ?? null,
    context: match.context ?? null,
  };

  const model = scout ? localModel(scout, advanced, extra) : null;
  const modelBasis: LocalEvaluatedMatch['modelBasis'] = model ? 'model' : 'market';
  const P: Record<string, number> = model
    ? model.probs
    : marketOnlyProbs(compOdds as unknown as Record<string, number>, realMarkets);

  const allMarkets = (Object.keys(P) as MarketType[]).filter((m) => Number.isFinite(P[m]));
  if (allMarkets.length === 0) return noDataEvaluation(match.id);

  const names = { home: match.home, away: match.away };
  const forced = match.forcedMarket;

  // Odd real do mercado; 0 = sem preço real (nunca sintético).
  const realOddOf = (m: MarketType): number => {
    if (isCompostaMarket(m)) {
      const odd = match.odds.comboOdds?.[m];
      return Number.isFinite(odd) && (odd as number) > 1.01 ? Number((odd as number).toFixed(2)) : 0;
    }
    if (realMarkets && !realMarkets.includes(m)) return 0;
    if (!realMarkets && m !== 'home' && m !== 'draw' && m !== 'away') return 0;
    return sanitizeOdd(compOdds[m as SimpleMarket], 0);
  };

  const allTips: TipOption[] = allMarkets.map((m) => {
    const odd = realOddOf(m);
    const p = clamp(P[m], 0.01, 0.99);
    return {
      market: m,
      label: labelForMarket(m, names),
      odds: odd > 1.01 ? odd : null,
      prob: Math.round(p * 100),
      p: Math.round(p * 10000) / 10000,
    } as TipOption;
  });

  const cands: Cand[] = allMarkets
    .filter((m) => !isCompostaMarket(m))
    .map((m) => ({ m, p: P[m], odd: realOddOf(m) }))
    .filter((x) => x.p > 0.01);

  const forcedApplied = !!forced && P[forced] !== undefined;
  let b: Cand;
  if (forcedApplied && forced) {
    b = { m: forced, p: P[forced], odd: realOddOf(forced) };
  } else {
    const valid = cands.filter((x) => x.odd >= CFG.band.oddFloor);
    b = pickInBand(valid.length ? valid : cands) ?? { m: 'home' as MarketType, p: 0, odd: 0 };
  }
  const priced = b.odd >= CFG.band.oddFloor;

  // V1: EV só faz sentido com modelo; em market-only p×odd−1 é ≈ −margem.
  const edge = modelBasis === 'model' && b.odd > 1.01 ? b.p * b.odd - 1 : 0;

  // Tip de odd alta para a Maluca: outro mercado do mesmo jogo, preço real.
  const mc = CFG.maluca;
  const pool = cands.filter((x) => x.odd > 1.01);
  const grounded = pool.filter(
    (x) => x.p * 100 >= mc.minProb && x.odd >= mc.minLegOdd && x.odd <= mc.maxLegOdd
  );
  const hrCands = grounded.length
    ? grounded
    : pool.filter((x) => x.p >= mc.fallback.minP && x.odd >= mc.fallback.minOdd && x.odd <= mc.fallback.maxOdd);
  const hr = [...hrCands].sort(
    (a, c) => Math.abs(a.odd - mc.idealLegOdd) - Math.abs(c.odd - mc.idealLegOdd)
      || c.p - a.p || c.odd - a.odd
  )[0];
  const highRiskTip: MatchTip | undefined = hr
    ? {
        market: hr.m,
        label: labelForMarket(hr.m, names),
        odds: hr.odd,
        prob: Math.round(clamp(hr.p, 0.01, 0.99) * 100),
        p: Math.round(clamp(hr.p, 0.01, 0.99) * 10000) / 10000,
      }
    : undefined;

  const pSel = clamp(b.p, 0.01, 0.99);
  const calib = Math.round(pSel * 100);

  let confidence = modelBasis === 'market' ? 0.3 : scout?._fromContext ? 0.55 : 0.8;
  const lin = match.lineups;
  if (lin && lin.available && lin.confirmed !== 1) confidence = Math.max(0.1, confidence - 0.05);
  if (modelBasis === 'market') confidence = Math.min(0.3, confidence);

  return {
    matchId: match.id,
    calibratedProb: calib,
    calibratedP: Math.round(pSel * 10000) / 10000,
    expectedValueEdge: Math.round(edge * 1000) / 10,
    recommendedMarket: b.m,
    marketLabel: labelForMarket(b.m, names),
    selectedOdds: b.odd,
    riskTier: tierFromProb(calib),
    highRiskTip,
    tips: allTips,
    confidence: Math.round(confidence * 1000) / 1000,
    modelBasis,
    priced,
    forcedApplied,
  };
}

// ---------------------------------------------------------------- métricas ---

class EngineMetrics {
  private total = 0;
  private marketOnly = 0;
  private none = 0;
  private modelCount = 0;
  private probSum = 0;
  private edgeSum = 0;
  private tiers: Record<SlipTier, number> =
    { segura: 0, moderada: 0, ousada: 0, maluca: 0, compostas: 0 };
  private markets = new Map<string, number>();
  private at: string | null = null;

  record(ev: LocalEvaluatedMatch) {
    this.total++;
    this.at = new Date().toISOString();
    if (ev.modelBasis === 'none') {
      this.none++;
      return;
    }
    if (ev.modelBasis === 'market') this.marketOnly++;
    if (ev.modelBasis === 'model') {
      this.modelCount++;
      // V1: EV só é significativo quando p veio do modelo.
      this.edgeSum += ev.expectedValueEdge;
    }
    this.probSum += ev.calibratedProb;
    this.tiers[ev.riskTier]++;
    this.markets.set(ev.recommendedMarket, (this.markets.get(ev.recommendedMarket) ?? 0) + 1);
  }

  snapshot() {
    const total = this.total;
    const scored = total - this.none;
    const topMarkets = [...this.markets.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([market, count]) => ({
        market: labelForMarket(market as MarketType, { home: 'Casa', away: 'Fora' }),
        count,
        percentage: scored ? Math.round((count / scored) * 100) : 0,
      }));
    return {
      totalInferences: total,
      marketOnlyInferences: this.marketOnly,
      noDataInferences: this.none,
      modelInferences: this.modelCount,
      nanFallbacks,
      avgCalibratedProb: scored ? Math.round(this.probSum / scored) : null,
      avgEdgeEV: this.modelCount
        ? Number((this.edgeSum / this.modelCount).toFixed(1))
        : null,
      activeTierBreakdown: { ...this.tiers },
      topMarkets,
      lastInferenceAt: this.at,
    };
  }
}

const metrics = new EngineMetrics();
export const getLocalCumulativeMetrics = () => metrics.snapshot();

/**
 * Async por compatibilidade com a assinatura do motor antigo; o cálculo é
 * síncrono e não faz await a nada.
 */
export async function callLocalInferenceEngine(
  input: LocalDecisionInput
): Promise<LocalInferenceResponse> {
  const t0 = performance.now();
  const evaluations = input.matches.map((m) => {
    try {
      return evaluateOne(m);
    } catch (err) {
      console.error('[AiScore] evaluateOne falhou', m.id, err);
      return noDataEvaluation(m.id);
    }
  });
  for (const ev of evaluations) metrics.record(ev);
  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
  if (CFG.log) {
    const mo = evaluations.filter((e) => e.modelBasis === 'market').length;
    const none = evaluations.filter((e) => e.modelBasis === 'none').length;
    console.log(
      `[AiScore Engine] ${evaluations.length} partida(s) em ${latencyMs}ms ` +
      `(${AISCORE_ENGINE_VERSION}; ${mo} só-mercado, ${none} sem dados).`
    );
  }
  return { modelVersion: AISCORE_ENGINE_VERSION, latencyMs, scope: input.scope,
    provider: 'local', evaluations };
}
