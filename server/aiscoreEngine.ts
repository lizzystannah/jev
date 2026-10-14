/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Motor probabilístico LOCAL — substitui o Jev (OpenRouter/TypeSafe).
 *
 * Usa TODAS as variáveis retornadas pelo AiScore via match/history
 * (entregues em `scout` + `advanced` no MatchItem):
 *
 *  Por jogo (home/away/h2h lists): id, date/matchTime, home_id/home,
 *    away_id/away, ft_home/ft_away (homeScores/awayScores packed sint32
 *    zigzag [FT,1H,2H,ET1,ET2,Pens] — FT = índice 0, nunca somar períodos),
 *    ht_home/ht_away, periods_home/away, statusId/matchStatus/finished,
 *    result W/D/L, gf/ga, side home/away, comp, roundNum
 *  Agregados last10/all: W/D/L, GF/GA, avg_gf/ga/total, over15/25/35,
 *    btts, clean_sheets, failed_to_score, avg_1h_goals, venue split
 *    home/away, form_last5/10, totals
 *  Trends (home/away + _sc): matches, win/draw/loss, goals/conceded,
 *    avgPossession, avgShots, winStreak, unbeatenRun, overGoals +
 *    overGoalsDots, bothScore + bothScoreDots, underCards + Dots,
 *    underCorners + Dots
 *  GoalDistributions (all/home/away): matches, scored[6 janelas
 *    0-15..76-90+], conceded[6], scored_by_window, conceded_by_window,
 *    scored_total/conceded_total
 *  H2H: n_finished, over15/25/35, btts, clean_sheets_focal, focal_wdl,
 *    unbeaten_run_longest + span, lista focal completa
 *  Meta: competition, kickoff, statusId (+ standings opcional)
 *  Odds de mercado: SÓ para EV (prob*odd-1) e escolha do mercado —
 *    nunca como única fonte de probabilidade.
 *
 * Determinístico, síncrono, sem rede, sem chave, sem LLM.
 * Espelha motor_aiscore.py do workspace Scraping (port fiel).
 */

import type { MarketType, MatchOdds, SlipScope, SlipTier } from './types.js';
import { deriveCompleteOdds, MARKET_LABELS } from './marketService.js';

export const AISCORE_ENGINE_VERSION = 'local/aiscore-engine-v1';

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
  }>;
}

export interface LocalEvaluatedMatch {
  matchId: string;
  calibratedProb: number;
  expectedValueEdge: number;
  recommendedMarket: MarketType;
  marketLabel: string;
  selectedOdds: number;
  riskTier: SlipTier;
  confidence: number;
  localScore: number;
}

export interface LocalInferenceResponse {
  modelVersion: string;
  latencyMs: number;
  scope: SlipScope;
  provider: 'local';
  evaluations: LocalEvaluatedMatch[];
}

// ---------------------------------------------------------------- helpers ---

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

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

function poissonPmf(lam: number, k: number): number {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lam) * Math.pow(lam, k) / fact;
}

function poissonMarkets(lamH: number, lamA: number): Record<string, number> {
  let pH = 0, pD = 0, pA = 0, o15 = 0, o25 = 0, o35 = 0, btts = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = poissonPmf(lamH, i) * poissonPmf(lamA, j);
      const tot = i + j;
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
      if (tot >= 2) o15 += p;
      if (tot >= 3) o25 += p;
      if (tot >= 4) o35 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  return { home: pH, draw: pD, away: pA, over15: o15, over25: o25, over35: o35,
    under25: 1 - o25, under35: 1 - o35, btts_yes: btts, btts_no: 1 - btts };
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

function teamBlock(form: any, trend: any, venueSide: 'home' | 'away', advLast10?: any): TeamBlock {
  // Precedência: advanced team_stats last10 (mais rico) > agregados do form >
  // derivado da lista de jogos. venueSide: 'home' p/ mandante, 'away' p/ visitante.
  const F = form || {};
  const t = trend || {};
  const A = advLast10 || {};
  const n = num(F.n ?? A.n ?? t.matches, 0);
  const der = deriveFromMatches(F.matches || A.matches, venueSide);

  const vAdv = (A.venue || {})[venueSide] || {};
  const vSco = F[venueSide] || {};
  const o25 = aggRate(A, F, 'over25') ?? der.over25Rate;
  const bt = aggRate(A, F, 'btts') ?? der.bttsRate;
  const cs = A.clean_sheets ?? F.clean_sheets ?? der.cleanSheets;
  const fts = A.failed_to_score ?? F.failed_to_score ?? der.failedToScore;
  const avg1h = A.avg_1h_goals ?? F.avg_1h_goals ?? der.avg1h;
  return {
    n, W: num(A.W ?? F.W), D: num(A.D ?? F.D), L: num(A.L ?? F.L),
    GF: num(A.GF ?? F.GF), GA: num(A.GA ?? F.GA),
    form: String(A.form_last10 ?? F.form ?? ''),
    venueN: num(vAdv.n || vSco.n || der.venueN),
    venueGf: num(vAdv.GF ?? der.venueGf),
    venueGa: num(vAdv.GA ?? der.venueGa),
    venueW: num(vAdv.W ?? vSco.W ?? der.venueW),
    venueD: num(vAdv.D ?? vSco.D ?? der.venueD),
    venueL: num(vAdv.L ?? vSco.L ?? der.venueL),
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

function lateBoost(advanced: any, homeId: string | null, awayId: string | null): number {
  let late = 0, tot = 0;
  const gds: any[] = Array.isArray(advanced?.goal_distributions)
    ? advanced.goal_distributions : [];
  for (const gd of gds) {
    if (gd?.team_id !== homeId && gd?.team_id !== awayId) continue;
    const it = gd?.all || {};
    const sbw = it.scored_by_window || {};
    const cbw = it.conceded_by_window || {};
    late += num(sbw['61-75']) + num(sbw['76-90+']) + num(cbw['61-75']) + num(cbw['76-90+']);
    tot += num(it.scored_total) + num(it.conceded_total);
  }
  if (!tot) return 0;
  return clamp((late / tot - 0.3) * 0.25, -0.03, 0.05);
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
    else if (x && typeof x === 'object' && (x as any).team_id) rows.push(x);
  }
  return rows;
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

function estimateXg(scout: any, advanced: any, extra?: EngineExtra): { xgH: number; xgA: number;
  H: TeamBlock; A: TeamBlock; H2: H2HBlock; boost: number; htAdj: number } {
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
  const homeId = scout?.home?.id ?? scout?.home_team_id ?? null;
  const awayId = scout?.away?.id ?? scout?.away_team_id ?? null;
  const boost = lateBoost(adv, homeId, awayId);

  const perGame = (b: TeamBlock): [number, number] => {
    const n = Math.max(1, b.n || 1);
    if (b.venueN >= 2) {
      return [0.55 * (b.venueGf / b.venueN) + 0.45 * (b.GF / n),
        0.55 * (b.venueGa / b.venueN) + 0.45 * (b.GA / n)];
    }
    return [b.GF / n, b.GA / n];
  };
  const [hGf, hGa] = perGame(H);
  const [aGf, aGa] = perGame(A);

  let xgH = (hGf + aGa) / 2;
  let xgA = (aGf + hGa) / 2;

  if (H2.n >= 2) {
    const half = H2.recentAvg / 2;
    xgH = 0.85 * xgH + 0.15 * half;
    xgA = 0.85 * xgA + 0.15 * half;
  }

  const momH = streakBonus(H.form) + Math.min(0.06, 0.02 * (H.unbeaten || 0));
  const momA = streakBonus(A.form) + Math.min(0.06, 0.02 * (A.unbeaten || 0));
  xgH *= 1 + momH;
  xgA *= 1 + momA;

  const shotEdge = clamp(((H.shots || 0) - (A.shots || 0)) / 10, -0.08, 0.08);
  xgH *= 1 + shotEdge;
  xgA *= 1 - shotEdge;
  xgH *= 1.03; // resíduo de mando

  // vitórias em casa/fora: aproveitamento no mando vs geral (+-5% max)
  const venueEdge = (b: TeamBlock): number => {
    if (!b.venueN || b.venueN < 2) return 0;
    const vwr = b.venueW / Math.max(1, b.venueN);
    const owr = b.W / Math.max(1, b.n || 1);
    return clamp((vwr - owr) * 0.3, -0.05, 0.05);
  };
  xgH *= 1 + venueEdge(H);
  xgA *= 1 + venueEdge(A);

  // classificação: PPG + saldo-de-golos por jogo (vale p/ grupos e ligas)
  const trows = tableRows(ex.tables);
  if (trows.length) {
    const byId: Record<string, any> = {};
    for (const r of trows) if (r?.team_id) byId[r.team_id] = r;
    const strength = (r: any): number | null => {
      const tot = num(r?.total);
      if (!tot || tot < 3 || r?.points == null) return null;
      const gd = num(r?.goalDiff);
      return (num(r.points) / tot) / 3 * 0.7 + clamp(gd / tot / 2, -1, 1) * 0.3;
    };
    const sH = homeId && byId[homeId] ? strength(byId[homeId]) : null;
    const sA = awayId && byId[awayId] ? strength(byId[awayId]) : null;
    if (sH != null && sA != null) {
      const adj = clamp((sH - sA) * 0.12, -0.06, 0.06);
      xgH *= 1 + adj;
      xgA *= 1 - adj;
    }
  }

  // escalações: nota dos titulares, capitão e desfalques
  const lin = ex.lineups;
  if (lin && typeof lin === 'object' && lin.available) {
    const lh = lineupSide(lin, 'home');
    const la = lineupSide(lin, 'away');
    if (lh.avg != null && la.avg != null) {
      const redge = clamp((lh.avg - la.avg) * 0.04, -0.04, 0.04);
      xgH *= 1 + redge;
      xgA *= 1 - redge;
    }
    if (lh.captainOut) xgH *= 0.98;
    if (la.captainOut) xgA *= 0.98;
    const [ownH, oppH] = posHit(lh.unavailable);
    const [ownA, oppA] = posHit(la.unavailable);
    if (ownH || oppA) xgH *= (1 - ownH) * (1 + oppA);
    if (ownA || oppH) xgA *= (1 - ownA) * (1 + oppH);
  }

  // descanso: diferença de dias desde o último jogo (+-4% max)
  const ctx = ex.context || {};
  if (typeof ctx.restDaysHome === 'number' && typeof ctx.restDaysAway === 'number') {
    const adj = clamp((ctx.restDaysHome - ctx.restDaysAway) * 0.008, -0.04, 0.04);
    xgH *= 1 + adj;
    xgA *= 1 - adj;
  }

  // ritmo de 1a parte: média de golos HT dos dois lados
  let htAdj = 0;
  if (H.avg1h != null && A.avg1h != null) {
    htAdj = clamp((H.avg1h + A.avg1h - 1.1) * 0.05, -0.03, 0.03);
  }

  // segunda amostra _sc como regularizador suave (quando o scout a traz)
  const hts = scout?.home_trend_sc || adv?.home_trend_sc;
  const ats = scout?.away_trend_sc || adv?.away_trend_sc;
  if (hts?.matches) xgH = 0.9 * xgH + 0.1 * (hts.goals / hts.matches + aGa) / 2;
  if (ats?.matches) xgA = 0.9 * xgA + 0.1 * (ats.goals / ats.matches + hGa) / 2;

  return { xgH: clamp(xgH || 1.2, 0.05, 4.5), xgA: clamp(xgA || 1.0, 0.05, 4.5), H, A, H2, boost, htAdj };
}

export function localProbabilities(scout: any, advanced: any, extra?: EngineExtra): Record<MarketType, number> {
  const { xgH, xgA, H, A, H2, boost, htAdj } = estimateXg(scout, advanced, extra);
  const ctx = extra?.context || (advanced || {}).context || {};
  const pois = poissonMarkets(xgH, xgA);

  const empO25 = (H.n + A.n) > 0 ? (H.over25Rate + A.over25Rate) / 2 : 0.5;
  const empBtts = (H.n + A.n) > 0 ? (H.bttsRate + A.bttsRate) / 2 : 0.4;
  const empO15 = clamp(empO25 * 1.45, 0, 0.97);
  const h2hW = Math.min(0.12, 0.03 * H2.n);

  let pO25 = clamp(0.6 * pois.over25 + 0.28 * empO25 + h2hW * H2.over25Rate + boost + htAdj, 0.02, 0.97);
  const pO15 = clamp(0.6 * pois.over15 + 0.28 * empO15 + h2hW * H2.over25Rate, 0.05, 0.98);
  const pO35 = clamp(0.65 * pois.over35 + 0.25 * clamp(empO25 * 0.55, 0, 1) + h2hW * H2.over25Rate * 0.5, 0.01, 0.9);
  let pBtts = clamp(0.6 * pois.btts_yes + 0.28 * empBtts + h2hW * H2.bttsRate, 0.02, 0.95);

  const csRate = (H.cleanSheets + A.cleanSheets) / Math.max(2, (H.n || 0) + (A.n || 0));
  const ftsRate = (H.failedToScore + A.failedToScore) / Math.max(2, (H.n || 0) + (A.n || 0));
  pBtts = clamp(pBtts * (1 - 0.5 * csRate) * (1 - 0.4 * ftsRate), 0.02, 0.95);

  const [pfH] = formPoints(H.form);
  const [pfA] = formPoints(A.form);
  const formEdge = clamp((pfH - pfA) * 0.35, -0.12, 0.12);
  let h2hEdge = 0;
  const totH2 = H2.W + H2.D + H2.L;
  if (totH2 >= 2) h2hEdge = clamp(((H2.W + 0.5 * H2.D) / totH2 - 0.5) * 0.5, -0.1, 0.1);
  // sequência invicta no confronto direto reforça o mandante focal
  if (H2.unbeatenLongest >= 3 && totH2 >= 2) {
    h2hEdge = clamp(h2hEdge + Math.min(0.05, 0.015 * (H2.unbeatenLongest - 2)), -0.1, 0.1);
  }

  let pH = clamp(pois.home * (1 + formEdge + h2hEdge), 0.02, 0.93);
  let pA = clamp(pois.away * (1 - formEdge - h2hEdge), 0.02, 0.93);
  const s = pH + pois.draw + pA;
  pH /= s; const pD = pois.draw / s; pA /= s;

  const underGame = (Math.min(1, (H.underCards + H.underCorners) / 20)
    + Math.min(1, (A.underCards + A.underCorners) / 20)) / 2;
  let pU25 = 1 - pO25;
  let pU35 = 1 - pO35;
  if (underGame > 0.85) {
    // jogo travado (cards/corners under altos): reforça unders
    pU35 = clamp(pU35 + 0.02, 0, 0.98);
    pU25 = clamp(pU25 + 0.015, 0, 0.97);
  }

  // importância: clássico/decisão tende a jogo fechado
  const imp = ctx.importance;
  if (imp === 'derby' || imp === 'decisiva') {
    pO25 = clamp(pO25 - 0.02, 0.02, 0.97);
    pU25 = clamp(pU25 + 0.02, 0, 0.97);
    pU35 = clamp(pU35 + 0.02, 0, 0.98);
    pBtts = clamp(pBtts - 0.015, 0.02, 0.95);
  }

  const probs: Record<string, number> = {
    home: pH, draw: pD, away: pA,
    double_chance_1x: 1 - pA, double_chance_x2: 1 - pH, double_chance_12: 1 - pD,
    over15: pO15, over25: pO25, over35: pO35,
    under25: pU25, under35: pU35,
    btts_yes: pBtts, btts_no: 1 - pBtts,
    dnb_home: clamp(pH / Math.max(0.05, pH + pD), 0.05, 0.97),
    dnb_away: clamp(pA / Math.max(0.05, pA + pD), 0.05, 0.97),
  };
  return probs as Record<MarketType, number>;
}

function essentialsFromContext(ctx: any): any {
  // Fallback quando o scout completo ainda não foi anexado: reconstrói um
  // scout mínimo a partir do MatchContext reduzido (recentForm/gols/H2H).
  if (!ctx || typeof ctx !== 'object') return null;
  const mk = (tf: any, n = 5) => {
    const rf: string[] = Array.isArray(tf?.recentForm) ? tf.recentForm : [];
    const gf = num(tf?.goalsScoredAvg5, 1.2);
    const ga = num(tf?.goalsConcededAvg5, 1.2);
    const csPct = num(tf?.cleanSheetPct, 20);
    const W = rf.filter((r) => r === 'W').length;
    const D = rf.filter((r) => r === 'D').length;
    const L = rf.filter((r) => r === 'L').length;
    return {
      n: rf.length || n, W, D, L, GF: +(gf * (rf.length || n)).toFixed(1),
      GA: +(ga * (rf.length || n)).toFixed(1), form: [...rf].reverse().join(''),
      clean_sheets: Math.round(((rf.length || n) * csPct) / 100),
      failed_to_score: 0,
      over25: { count: Math.round((rf.length || n) * 0.4), n: rf.length || n },
      btts: { count: Math.round((rf.length || n) * 0.4), n: rf.length || n },
      venue: { n: 0, GF: 0, GA: 0 },
    };
  };
  const h2h = ctx.h2h || {};
  const total = num(h2h.homeWins) + num(h2h.draws) + num(h2h.awayWins);
  return {
    home_form: mk(ctx.homeForm),
    away_form: mk(ctx.awayForm),
    h2h: [],
    h2h_summary: { W: num(h2h.homeWins), D: num(h2h.draws), L: num(h2h.awayWins) },
    home_trend: { matches: 5, win: 0, draw: 0, loss: 0, goals: 0, conceded: 0,
      avgPossession: 45, avgShots: '6.0', unbeatenRun: 0, overGoals: 0,
      bothScore: Math.round(total * (num(h2h.bothScoredPct) / 100)) || 0,
      underCards: 8, underCorners: 8 },
    away_trend: { matches: 5, win: 0, draw: 0, loss: 0, goals: 0, conceded: 0,
      avgPossession: 45, avgShots: '6.0', unbeatenRun: 0, overGoals: 0,
      bothScore: 0, underCards: 8, underCorners: 8 },
    _fromContext: true,
  };
}

export function evaluateOne(match: LocalDecisionInput['matches'][number]): LocalEvaluatedMatch {
  const compOdds = deriveCompleteOdds(match.odds) as Record<MarketType, number>;
  const scout = match.scout || essentialsFromContext(match.context);
  const advanced = match.advanced || (match.scout as any)?.advanced || null;
  const extra: EngineExtra = {
    tables: (match as any).tables ?? null,
    lineups: (match as any).lineups ?? null,
    context: match.context ?? null,
  };
  const probs = scout ? localProbabilities(scout, advanced, extra) : null;

  // Sem scout nem contexto: cai para a leitura de mercado (nunca ideal,
  // mas mantém o pipeline a gerar em vez de falhar).
  const fallbackProbs = (() => {
    const pH = (1 / compOdds.home) * 100;
    const pD = (1 / compOdds.draw) * 100;
    const pA = (1 / compOdds.away) * 100;
    const s = pH + pD + pA;
    return {
      home: pH / s, draw: pD / s, away: pA / s,
      double_chance_1x: 1 - pA / s, double_chance_x2: 1 - pH / s,
      double_chance_12: 1 - pD / s,
      over15: 0.75, over25: (1 / compOdds.over25) * 0.95, over35: 0.3,
      under25: 1 - (1 / compOdds.over25) * 0.95, under35: 0.7,
      btts_yes: (1 / compOdds.btts_yes) * 0.95, btts_no: 1 - (1 / compOdds.btts_yes) * 0.95,
      dnb_home: 0.55, dnb_away: 0.45,
    } as Record<MarketType, number>;
  })();
  const P = probs || fallbackProbs;

  const floorOf = (m: MarketType): number =>
    m === 'double_chance_1x' || m === 'double_chance_x2'
    || m === 'over15' || m === 'under35' ? 0.45 : 0.5;
  let best: { m: MarketType; p: number; odd: number; edge: number; score: number } | null = null;
  (Object.keys(P) as MarketType[]).forEach((m) => {
    const p = P[m] ?? 0;
    const odd = sanitizeOdd((compOdds as any)[m]);
    const edge = p * odd - 1;
    const score = p >= floorOf(m) ? edge : edge - 1;
    if (!best || score > best.score) best = { m, p, odd, edge, score };
  });

  const b = best!;
  const calib = Math.round(clamp(b.p, 0.1, 0.95) * 100);
  const edgePct = Math.round(b.edge * 100 * 10) / 10;
  const riskTier: SlipTier = calib >= 63 ? 'segura' : calib >= 48 ? 'moderada' : 'ousada';
  const labelFn = MARKET_LABELS[b.m];
  let confidence = scout?._fromContext ? 0.55 : 0.8;
  const lin = (match as any).lineups;
  if (lin && lin.available && lin.confirmed !== 1) confidence = Math.max(0.1, confidence - 0.05);
  return {
    matchId: match.id,
    calibratedProb: calib,
    expectedValueEdge: edgePct,
    recommendedMarket: b.m,
    marketLabel: labelFn ? labelFn({ home: match.home, away: match.away }) : b.m,
    selectedOdds: b.odd,
    riskTier,
    confidence: Math.round(confidence * 1000) / 1000,
    localScore: Math.round(calib * 0.7 + Math.max(0, edgePct) * 1.2),
  };
}

// ---------------------------------------------------------------- métricas ---

interface AccStats {
  total: number; probSum: number; edgeSum: number;
  tiers: Record<SlipTier, number>; markets: Record<string, number>;
  at: string;
}

const ACC: AccStats = { total: 0, probSum: 0, edgeSum: 0,
  tiers: { segura: 0, moderada: 0, ousada: 0 }, markets: {}, at: new Date().toISOString() };

export function getLocalCumulativeMetrics() {
  const total = ACC.total;
  const topMarkets = Object.entries(ACC.markets)
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([market, count]) => ({
      market: MARKET_LABELS[market as MarketType]
        ? MARKET_LABELS[market as MarketType]({ home: 'Casa', away: 'Fora' }) : market,
      count, percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    }));
  return {
    totalInferences: total,
    avgCalibratedProb: total > 0 ? Math.round(ACC.probSum / total) : 64,
    avgEdgeEV: total > 0 ? Number((ACC.edgeSum / total).toFixed(1)) : 8.4,
    activeTierBreakdown: { ...ACC.tiers },
    topMarkets: topMarkets.length > 0 ? topMarkets : [
      { market: '1X (Dupla Chance)', count: 0, percentage: 0 },
      { market: '+1.5 Golos', count: 0, percentage: 0 },
      { market: 'Ambas Marcam (BTTS)', count: 0, percentage: 0 },
      { market: '-3.5 Golos', count: 0, percentage: 0 },
    ],
    lastInferenceAt: ACC.at,
  };
}

/**
 * Substituto direto de callJevInferenceEngine — mesma forma de resposta,
 * sem OpenRouter, sem chave, sem rede. Síncrono por dentro, async por fora
 * para não mexer na assinatura do ticketEngine.
 */
export async function callLocalInferenceEngine(
  input: LocalDecisionInput
): Promise<LocalInferenceResponse> {
  const start = Date.now();
  const evaluations = input.matches.map(evaluateOne);
  for (const ev of evaluations) {
    ACC.total++;
    ACC.probSum += ev.calibratedProb;
    ACC.edgeSum += ev.expectedValueEdge;
    ACC.tiers[ev.riskTier]++;
    ACC.markets[ev.recommendedMarket] = (ACC.markets[ev.recommendedMarket] || 0) + 1;
  }
  ACC.at = new Date().toISOString();
  const latencyMs = Math.max(1, Date.now() - start);
  console.log(`[AiScore Engine] ${evaluations.length} partida(s) calibradas localmente em ${latencyMs}ms (${AISCORE_ENGINE_VERSION}).`);
  return { modelVersion: AISCORE_ENGINE_VERSION, latencyMs,
    scope: input.scope, provider: 'local', evaluations };
}
