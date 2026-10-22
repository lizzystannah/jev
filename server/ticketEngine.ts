/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BetSlip, MatchItem, SlipScope, SlipTier } from './types.js';
import { marketService, leaguePriorityRank, isObscureLeague, isMainLeague } from './marketService.js';
import { callLocalInferenceEngine, type LocalDecisionInput } from './aiscoreEngine.js';
import { aiscoreClient } from './aiscoreService.js';
import { bilheteriaDb } from './db.js';
import { getDayKey } from './time.js';

/**
 * Peso por liga (jefe prioriza as principais):
 * Champions 1.30 > Europa 1.22 > EPL 1.18 > La Liga 1.15 >
 * Serie A/Bundesliga 1.10 > Ligue 1 1.08 > outras top 1.05 > resto 1.0
 */
const LEAGUE_WEIGHTS = [1.30, 1.22, 1.18, 1.15, 1.10, 1.10, 1.08, 1.05];

export function leagueWeight(league?: string | null, competitionId?: string | null): number {
  const rank = leaguePriorityRank(league, competitionId);
  if (rank >= 99) return 1.0;
  return LEAGUE_WEIGHTS[Math.min(rank, LEAGUE_WEIGHTS.length - 1)] ?? 1.0;
}

export function isTopTierLeague(league?: string | null, competitionId?: string | null): boolean {
  return leaguePriorityRank(league, competitionId) < 8;
}

// Metas de odd combinada por construção ousada.
const OUSADA_MIN_ODDS = 10;
// Super Acumulada: muitas pernas NORMAIS (tips do motor, sem lotaria).
const SUPER_LEGS_TARGET = 20;
const SUPER_LEGS_MIN = 8;

// Liga obscura (feminino/base/exótica) vale pouco na ordenação.
const OBSCURE_PENALTY = 0.55;

/** Score de ordenação: probabilidade calibrada × peso da liga (obscura penalizada). */
function pickScore(m: MatchItem): number {
  return m.tip.prob * leagueWeight(m.league, m.competitionId) * (isObscureLeague(m.league) ? OBSCURE_PENALTY : 1);
}

/** Valor esperado aproximado: odd × probabilidade × peso da liga (obscura penalizada). */
function valueScore(m: MatchItem): number {
  return m.tip.odds * (m.tip.prob / 100) * leagueWeight(m.league, m.competitionId) * (isObscureLeague(m.league) ? OBSCURE_PENALTY : 1);
}

/**
 * Ligas principais primeiro: ordena cada grupo pelo critério e concatena
 * top-tier antes do resto. Bilhetes saem com ligas grandes; as estranhas
 * só entram para completar quando faltam jogos principais.
 */
function orderTopFirst(arr: MatchItem[], sortFn: (a: MatchItem, b: MatchItem) => number): MatchItem[] {
  const top = arr.filter((m) => isTopTierLeague(m.league, m.competitionId)).sort(sortFn);
  const rest = arr.filter((m) => !isTopTierLeague(m.league, m.competitionId)).sort(sortFn);
  return [...top, ...rest];
}

/**
 * Garante quota mínima de ligas principais: se o pool tem jogo top-tier
 * mas as pernas selecionadas não, troca a última perna pela melhor top-tier.
 */
function ensureTopTierLegs(legs: MatchItem[], pool: MatchItem[]): MatchItem[] {
  if (legs.length === 0 || legs.some((l) => isTopTierLeague(l.league, l.competitionId))) return legs;
  const candidates = pool
    .filter((m) => isTopTierLeague(m.league, m.competitionId) && !legs.some((l) => l.id === m.id))
    .sort((a, b) => b.tip.prob * leagueWeight(b.league, b.competitionId) - a.tip.prob * leagueWeight(a.league, a.competitionId));
  if (candidates.length === 0) return legs;
  return [...legs.slice(0, -1), candidates[0]];
}

/**
 * Coerência de um conjunto de pernas: probabilidades próximas, ligas
 * diversificadas, presença de ligas principais e odds sem exagero.
 * Serve para escolher bilhetes equilibrados em vez de só os de maior score.
 */
function legsCoherence(legs: MatchItem[]): number {
  if (legs.length === 0) return 0;
  const probs = legs.map((l) => l.tip.prob);
  const odds = legs.map((l) => l.tip.odds);
  const avgProb = probs.reduce((a, b) => a + b, 0) / probs.length;
  const spread = Math.max(...probs) - Math.min(...probs);
  const leagueRatio = new Set(legs.map((l) => l.league)).size / legs.length;
  const topRatio = legs.filter((l) => isTopTierLeague(l.league, l.competitionId)).length / legs.length;
  const avgOdds = odds.reduce((a, b) => a + b, 0) / odds.length;
  const forcedRatio = legs.filter((l) => l.tip.odds > 2.8).length / legs.length;
  return (
    avgProb +
    leagueRatio * 12 +
    topRatio * 12 -
    spread * 0.5 -
    Math.max(0, avgOdds - 2.2) * 6 -
    forcedRatio * 15
  );
}

/**
 * Escolhe pernas de forma coerente: uma por liga enquanto houver alternativas,
 * respeitando um piso de probabilidade. Nunca reaproveita jogos já usados.
 */
function takeCoherent(
  arr: MatchItem[],
  n: number,
  used: Set<string>,
  floorProb: number
): MatchItem[] {
  const pool = arr.filter((m) => !used.has(m.id) && m.tip.prob >= floorProb);
  if (pool.length < n) return [];

  const picked: MatchItem[] = [];
  const perLeague = new Map<string, number>();
  for (const m of pool) {
    if (picked.length >= n) break;
    const c = perLeague.get(m.league) || 0;
    if (c >= 1) continue;
    picked.push(m);
    perLeague.set(m.league, c + 1);
  }
  if (picked.length < n) {
    for (const m of pool) {
      if (picked.length >= n) break;
      if (picked.some((p) => p.id === m.id)) continue;
      picked.push(m);
    }
  }
  return picked;
}

export const TIERS_CONFIG = {
  segura: { min: 63, max: 101, color: 'var(--green-tier, #4FAE73)', hex: '#4FAE73' },
  moderada: { min: 48, max: 63, color: 'var(--amber-tier, #E7B33E)', hex: '#E7B33E' },
  ousada: { min: 0, max: 48, color: 'var(--red-tier, #D1594B)', hex: '#D1594B' },
};

// Configuração de pernas por categoria e longevidade
export const LEGS_CONFIG: Record<SlipScope, Record<SlipTier, number>> = {
  dia: { segura: 2, moderada: 3, ousada: 3 },
  '2_3_dias': { segura: 3, moderada: 3, ousada: 4 },
  longo: { segura: 3, moderada: 4, ousada: 4 },
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Estoque mínimo de fichas PENDENTES por horizonte.
 * O agendador repõe automaticamente sempre que uma ficha cai (ganha/perde/expira)
 * ou quando a mudança do dia cria a nova fornada de "Hoje".
 */
export const SCOPE_QUOTAS: Record<SlipScope, number> = {
  dia: envInt('TICKETS_QUOTA_DIA', 3),
  '2_3_dias': envInt('TICKETS_QUOTA_MED', 3),
  longo: envInt('TICKETS_QUOTA_LONGO', 2),
};

/** Teto de segurança para o botão manual "Gerar" não inundar o estoque. */
export const SCOPE_MAX_PENDING: Record<SlipScope, number> = {
  dia: SCOPE_QUOTAS.dia + 2,
  '2_3_dias': SCOPE_QUOTAS['2_3_dias'] + 2,
  longo: SCOPE_QUOTAS.longo + 2,
};

/** Horas de tolerância após o último pontapé inicial antes de marcar como vencida. */
export const EXPIRY_GRACE_HOURS = envInt('TICKETS_EXPIRY_GRACE_HOURS', 6);

export interface GenerateOptions {
  /** Máximo de fichas novas a devolver nesta geração (default: 5). */
  limit?: number;
}


function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i + size <= arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export class TicketEngine {
  private slips: BetSlip[] = [];
  private slipCounter = 100;
  private lastJevLatencyMs = 62;
  private initialized = false;

  /**
   * Carrega as fichas persistidas para memória. Deve ser chamado uma única vez
   * no arranque, depois de `bilheteriaDb.init()`.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    this.slips = await bilheteriaDb.loadSlips();
    // Continua a numeração a partir da última ficha persistida (evita IDs repetidos).
    let maxSeq = 100;
    for (const slip of this.slips) {
      const m = /(\d+)$/.exec(slip.id);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    this.slipCounter = Math.max(maxSeq, Number(bilheteriaDb.getMeta('slip_counter') || 0));
    this.initialized = true;
  }

  public getSlips(): BetSlip[] {
    return this.slips;
  }

  public getSlipById(id: string): BetSlip | undefined {
    return this.slips.find((s) => s.id === id);
  }

  public getLastJevLatency(): number {
    return this.lastJevLatencyMs;
  }

  public createSlip(
    scope: SlipScope,
    tier: SlipTier,
    legs: MatchItem[],
    options?: { customTitle?: string; rationale?: string; isAiGenerated?: boolean }
  ): BetSlip {
    const seenMatchIds = new Set<string>();
    const uniqueLegs = legs.filter((m) => {
      if (seenMatchIds.has(m.id)) return false;
      seenMatchIds.add(m.id);
      return true;
    });

    const combinedOdds = Number(uniqueLegs.reduce((acc, m) => acc * m.tip.odds, 1).toFixed(2));
    const combinedProb = Number((uniqueLegs.reduce((acc, m) => acc * (m.tip.prob / 100), 1) * 100).toFixed(1));
    const tierConfig = TIERS_CONFIG[tier] || TIERS_CONFIG.moderada;
    const expiresAt = uniqueLegs.length > 0 ? Math.min(...uniqueLegs.map((l) => l.kickoffAt)) : Date.now();

    const scopePrefix = scope === '2_3_dias' ? 'MED' : scope === 'dia' ? 'DIA' : 'LONGO';

    const createdAt = Date.now();
    this.slipCounter += 1;
    bilheteriaDb.setMeta('slip_counter', String(this.slipCounter));

    const slip: BetSlip = {
      id: `${scopePrefix}-${tier.substring(0, 3).toUpperCase()}-${this.slipCounter}`,
      scope,
      tier,
      color: tierConfig.color,
      legs: uniqueLegs,
      combinedOdds,
      combinedProb,
      expiresAt,
      status: 'pendente',
      createdAt,
      resolvedAt: null,
      customTitle: options?.customTitle,
      rationale: options?.rationale,
      isAiGenerated: options?.isAiGenerated ?? true, // Criado com base no motor local
      dayKey: getDayKey(createdAt),
    };

    return slip;
  }

  /**
   * Pipeline de criação com o motor LOCAL AiScore (sem Jev, sem OpenRouter):
   * 1. Filtra os jogos para o horizonte da longevidade (dia: 0 dias; 2_3_dias: 1 a 3 dias; longo: 4+ dias)
   * 2. Enriquece com o scout COMPLETO do AiScore (H2H, forma, trends, janelas de golo, odds)
   * 3. O motor local calcula xG (Poisson) + taxas empíricas + H2H + mando e devolve
   *    probabilidades calibradas, mercado de valor e EV — determinístico
   * 4. Aplica as regras de negócio de bilhetes combinados e seleciona os TOP bilhetes (até 5)
   */
  public async generateTicketsForScope(
    scope: SlipScope,
    activeLeagues?: string[],
    options?: GenerateOptions
  ): Promise<{ generated: BetSlip[]; all: BetSlip[]; jevLatencyMs: number }> {
    const allMatches = await marketService.getMatches();

    // Filtro estrito do horizonte de longevidade e proteção absoluta contra jogos passados
    const now = Date.now();
    const filtered = allMatches.filter((m) => {
      const matchLeague = !activeLeagues || activeLeagues.length === 0 || activeLeagues.includes(m.league);
      const notResolved = m.status !== 'resolved';
      const isFutureMatch = m.kickoffAt > now; // Jamais criar bilhetes com jogos passados ou iniciados

      let matchScopeMatches = false;
      if (scope === 'dia') {
        matchScopeMatches = m.daysFromNow === 0;
      } else if (scope === '2_3_dias') {
        matchScopeMatches = m.daysFromNow >= 1 && m.daysFromNow <= 3;
      } else {
        // longo prazo: 4 dias ou mais
        matchScopeMatches = m.daysFromNow >= 4;
      }

      return matchLeague && matchScopeMatches && notResolved && isFutureMatch;
    });

    // Só ligas principais no pool de bilhetes: femininos, base/exóticas e
    // segunda/terceira divisão ficam de fora (continuam visíveis nos jogos).
    const eligible = filtered.filter((m) => isMainLeague(m.league, m.competitionId));

    if (eligible.length === 0) {
      return { generated: [], all: this.slips, jevLatencyMs: 0 };
    }

    // Enriquece com o scout COMPLETO do AiScore (todas as variáveis) antes
    // do motor local — falha não bloqueia (o motor usa o contexto resumido).
    // Orçamento curto no passo rápido; enrich completo corre em background.
    // includeLineups só no dia: escalaçes só existem perto do pontapé inicial.
    const wantLineups = scope === 'dia';
    try {
      const n = await aiscoreClient.enrichMatches(eligible, { maxMatches: 6, deadlineMs: 18_000, includeLineups: wantLineups });
      if (n > 0) {
        console.log(`[AiScore] ${n} partida(s) com scout completo anexado ao motor local.`);
      }
      void aiscoreClient
        .enrichMatches(eligible, { maxMatches: 40, deadlineMs: 90_000, includeLineups: wantLineups })
        .catch(() => undefined);
    } catch (err: any) {
      console.warn('[AiScore] Enriquecimento de contexto falhou (motor local segue com odds):', err?.message);
    }

    // Prepara a entrada do motor local (scout completo + odds)
    const horizonDays = scope === 'dia' ? 0 : scope === '2_3_dias' ? 3 : 7;
    const localInput: LocalDecisionInput = {
      scope,
      horizonDays,
      matches: eligible.map((m) => ({
        id: m.id,
        league: m.league,
        home: m.home,
        away: m.away,
        daysFromNow: m.daysFromNow,
        odds: m.odds,
        context: m.context,
        scout: (m as any).scout,
        advanced: (m as any).advanced,
        tables: (m as any).tables,
        lineups: (m as any).lineups,
      })),
    };

    // Inferência local determinística (sem rede, sem chave)
    const localResponse = await callLocalInferenceEngine(localInput);
    this.lastJevLatencyMs = localResponse.latencyMs;

    // Atualiza cada partida no pool com a probabilidade calibrada local
    const matchEvaluationsMap = new Map(localResponse.evaluations.map((e) => [e.matchId, e]));

    const evaluatedMatches: MatchItem[] = eligible.map((m) => {
      const ev = matchEvaluationsMap.get(m.id);
      if (!ev) return m;

      // Anexa a inferência do motor local
      m.jevInference = {
        calibratedProb: ev.calibratedProb,
        expectedValueEdge: ev.expectedValueEdge,
        recommendedMarket: ev.recommendedMarket,
        riskTier: ev.riskTier,
        latencyMs: localResponse.latencyMs,
        jevModelVersion: localResponse.modelVersion,
      };

      // Atualiza a tip recomendada diretamente a partir do motor local
      m.tip = {
        market: ev.recommendedMarket,
        label: ev.marketLabel,
        odds: ev.selectedOdds,
        prob: ev.calibratedProb,
      };

      return m;
    });

    // Separação em Buckets de Probabilidade (Segura, Moderada, Ousada)
    const buckets: Record<SlipTier, MatchItem[]> = {
      segura: [],
      moderada: [],
      ousada: [],
    };

    evaluatedMatches.forEach((m) => {
      if (m.tip.prob >= TIERS_CONFIG.segura.min) {
        buckets.segura.push(m);
      } else if (m.tip.prob >= TIERS_CONFIG.moderada.min) {
        buckets.moderada.push(m);
      } else {
        buckets.ousada.push(m);
      }
    });

    // NÃO apagar fichas pendentes existentes: elas persistem até resolverem ou
    // expirarem. A geração apenas acrescenta novas oportunidades ao estoque.

    // Construtor Especializado para o Tier "Ousada" (mínimo de odd combinada).
    // Usa as tips REAIS do motor — nunca inventa probabilidades para forçar odd.
    const buildOusadaSlip = (matchesPool: MatchItem[]): BetSlip | null => {
      if (matchesPool.length < 3) return null;

      const ordered = orderTopFirst([...matchesPool], (a, b) => valueScore(b) - valueScore(a));
      const coherent = ordered.filter(
        (m) => m.tip.prob >= 38 && m.tip.odds >= 1.25 && m.tip.odds <= 3.2
      );
      const pool = coherent.length >= 3 ? coherent : ordered;

      const selectedLegs: MatchItem[] = [];
      let currentCombinedOdds = 1.0;

      for (const match of pool) {
        if (selectedLegs.some((l) => l.id === match.id)) continue;

        // Prefere ligas diferentes; só repete quando não há alternativa.
        const usedLeagues = new Set(selectedLegs.map((l) => l.league));
        const hasAlternative = pool.some(
          (m) =>
            !selectedLegs.some((l) => l.id === m.id) &&
            !usedLeagues.has(m.league)
        );
        if (usedLeagues.has(match.league) && hasAlternative) continue;

        selectedLegs.push(match);
        currentCombinedOdds *= match.tip.odds;

        // Atingiu o mínimo de odd combinada com pelo menos 3 pernas.
        if (currentCombinedOdds >= OUSADA_MIN_ODDS && selectedLegs.length >= 3) break;
        // Limite máximo de segurança de 7 pernas.
        if (selectedLegs.length >= 7) break;
      }

      // Sem odd mínima com tips coerentes: não fabrica um bilhete "ousado" à força.
      if (selectedLegs.length < 3 || currentCombinedOdds < OUSADA_MIN_ODDS) return null;

      const finalLegs = ensureTopTierLegs(selectedLegs, pool);
      const finalOdds = finalLegs.reduce((acc, l) => acc * l.tip.odds, 1);

      return this.createSlip(scope, 'ousada', finalLegs, {
        customTitle: `Super Múltipla Ousada (${finalOdds.toFixed(2)}x)`,
        rationale: `Bilhete de alto retorno com odd combinada de ${finalOdds.toFixed(2)}, montado com as tips calibradas do motor e ligas diversificadas.`,
      });
    };

    /**
     * Super Acumulada: até 20 pernas NORMAIS (tips calibradas do motor,
     * sem mercados de lotaria). Escolhe jogos de pontuação COERENTE em vez
     * de empilhar só os maiores scores: piso de probabilidade, no máximo
     * 2 jogos por liga e sem ligas obscuras/divisões inferiores.
     */
    const buildSuperOusadaSlip = (
      matchesPool: MatchItem[], used: Set<string>
    ): BetSlip | null => {
      const ordered = orderTopFirst([...matchesPool],
        (a, b) => pickScore(b) - pickScore(a));
      const fresh = ordered.filter((m) => !used.has(m.id));
      const reuse = ordered.filter((m) => used.has(m.id));

      const pick = (floorProb: number): { legs: MatchItem[]; odds: number } => {
        const legs: MatchItem[] = [];
        const perLeague = new Map<string, number>();
        let odds = 1.0;
        for (const match of [...fresh, ...reuse]) {
          if (legs.length >= SUPER_LEGS_TARGET) break;
          if (legs.some((l) => l.id === match.id)) continue;
          if (match.tip.prob < floorProb) continue;
          const c = perLeague.get(match.league) || 0;
          if (c >= 2) continue;
          legs.push(match);
          perLeague.set(match.league, c + 1);
          odds *= match.tip.odds;
        }
        return { legs, odds };
      };

      let result = pick(58);
      if (result.legs.length < SUPER_LEGS_MIN) result = pick(50);
      if (result.legs.length < SUPER_LEGS_MIN) return null;

      const { legs, odds } = result;
      return this.createSlip(scope, 'ousada', legs, {
        customTitle: `Super Acumulada (${legs.length} jogos • ${odds.toFixed(2)}x)`,
        rationale: `Acumulador de ${legs.length} pernas de ligas principais com probabilidades coerentes, odd combinada de ${odds.toFixed(2)}.`,
      });
    };

    const candidateSlips: BetSlip[] = [];
    const legsMap = LEGS_CONFIG[scope];

    // Jogos já usados noutro bilhete: cada construção prefere pernas frescas
    // para os bilhetes não saírem todos iguais.
    const usedIds = new Set<string>();
    const claim = (legs: MatchItem[]): void => {
      legs.forEach((l) => usedIds.add(l.id));
    };
    /**
     * Cria até duas variações de um tier usando pernas frescas e coerentes.
     * A segunda variação só existe se houver jogos suficientes sem repetir.
     */
    const buildTierVariants = (
      tier: SlipTier,
      arr: MatchItem[],
      legsCount: number,
      floorProb: number
    ): void => {
      for (let i = 0; i < 2; i++) {
        const legs = takeCoherent(arr, legsCount, usedIds, floorProb);
        if (legs.length < legsCount) return;
        candidateSlips.push(this.createSlip(scope, tier, ensureTopTierLegs(legs, arr)));
        claim(legs);
      }
    };

    // 1. Bilhetes Seguros (ligas principais primeiro, probabilidades coerentes)
    const sortedSegura = orderTopFirst(
      [...(buckets.segura.length >= 2 ? buckets.segura : evaluatedMatches)],
      (a, b) => pickScore(b) - pickScore(a)
    );
    buildTierVariants('segura', sortedSegura, legsMap.segura, 58);

    // 2. Bilhetes Moderados (ligas principais primeiro, equilíbrio de probabilidade)
    const sortedModerada = orderTopFirst(
      [...(buckets.moderada.length >= 2 ? buckets.moderada : evaluatedMatches)],
      (a, b) => valueScore(b) - valueScore(a)
    );
    buildTierVariants('moderada', sortedModerada, legsMap.moderada, 45);

    // 3. Bilhetes Ousados (mínimo de odd combinada garantido)
    const freshOusada = (pool: MatchItem[]): MatchItem[] => {
      const f = pool.filter((m) => !usedIds.has(m.id));
      return f.length >= 3 ? f : pool;
    };
    const ousadaSlip1 = buildOusadaSlip(freshOusada(evaluatedMatches));
    if (ousadaSlip1) {
      candidateSlips.push(ousadaSlip1);
      claim(ousadaSlip1.legs);
    }

    // Segunda variação de Ousada com pernas frescas
    if (evaluatedMatches.length >= 4) {
      const ousadaSlip2 = buildOusadaSlip(freshOusada(evaluatedMatches));
      if (ousadaSlip2 && ousadaSlip2.combinedOdds !== ousadaSlip1?.combinedOdds) {
        candidateSlips.push(ousadaSlip2);
        claim(ousadaSlip2.legs);
      }
    }

    // 4. SUPER ACUMULADA (até 20 jogos, tips normais).
    const superOusada = buildSuperOusadaSlip(evaluatedMatches, usedIds);
    if (superOusada) {
      candidateSlips.push(superOusada);
      claim(superOusada.legs);
    }

    // REGRA DE NEGÓCIO: reter bilhetes COERENTES (probabilidades próximas,
    // ligas diversificadas), não apenas os de maior pontuação/odd.
    const finalSlips: BetSlip[] = [];
    const seguraList = candidateSlips.filter((s) => s.tier === 'segura').sort((a, b) => legsCoherence(b.legs) - legsCoherence(a.legs));
    const moderadaList = candidateSlips.filter((s) => s.tier === 'moderada').sort((a, b) => legsCoherence(b.legs) - legsCoherence(a.legs));
    const ousadaList = candidateSlips.filter((s) => s.tier === 'ousada').sort((a, b) => legsCoherence(b.legs) - legsCoherence(a.legs));

    if (seguraList[0]) finalSlips.push(seguraList[0]);
    if (seguraList[1]) finalSlips.push(seguraList[1]);
    if (moderadaList[0]) finalSlips.push(moderadaList[0]);
    if (moderadaList[1]) finalSlips.push(moderadaList[1]);
    if (ousadaList[0]) finalSlips.push(ousadaList[0]);
    if (ousadaList[1] && finalSlips.length < 5) finalSlips.push(ousadaList[1]);

    // Evita repetir pernas de fichas que já estão no estoque pendente do mesmo
    // horizonte. Se não houver candidatos totalmente frescos, aceita os que não
    // sejam exatamente iguais a uma ficha existente (mercado pode estar curto).
    const existingPending = this.slips.filter(
      (s) => s.scope === scope && s.status === 'pendente'
    );
    const reservedLegIds = new Set<string>();
    existingPending.forEach((s) => s.legs.forEach((l) => reservedLegIds.add(l.id)));

    const freshCandidates = finalSlips.filter(
      (s) => !s.legs.some((l) => reservedLegIds.has(l.id))
    );
    const notIdentical = finalSlips.filter(
      (s) =>
        !existingPending.some(
          (e) =>
            e.legs.length === s.legs.length &&
            e.legs.every((el) => s.legs.some((sl) => sl.id === el.id))
        )
    );

    const candidatePool = freshCandidates.length > 0 ? freshCandidates : notIdentical;
    const wanted = Math.max(1, options?.limit ?? 5);
    const topSlips = candidatePool.slice(0, wanted);

    for (const slip of topSlips) {
      this.slips.push(slip);
    }
    bilheteriaDb.upsertMany(topSlips);

    return {
      generated: topSlips,
      all: this.slips,
      jevLatencyMs: localResponse.latencyMs,
    };
  }

  public validateSlips(): { updatedSlips: BetSlip[] } {
    const updated: BetSlip[] = [];
    const now = Date.now();
    const graceMs = EXPIRY_GRACE_HOURS * 60 * 60 * 1000;

    for (const slip of this.slips) {
      if (slip.status !== 'pendente') continue;

      let anyLost = false;
      let allResolved = true;
      let dirty = false;

      for (let i = 0; i < slip.legs.length; i++) {
        const currentLeg = slip.legs[i];
        // Sincroniza em tempo real com o estado mais recente da partida no marketService
        const freshMatch = marketService.getMatchById(currentLeg.id);
        if (freshMatch) {
          if (
            freshMatch.status !== currentLeg.status ||
            JSON.stringify(freshMatch.result ?? null) !== JSON.stringify(currentLeg.result ?? null)
          ) {
            dirty = true;
          }
          slip.legs[i] = {
            ...freshMatch,
            tip: currentLeg.tip, // Mantém o prognóstico fixado no momento da aposta
            jevInference: currentLeg.jevInference,
          };
        }

        const leg = slip.legs[i];
        if (leg.status !== 'resolved') {
          allResolved = false;
        } else if (leg.result && !leg.result.tipWon) {
          // Se qualquer perna errou o prognóstico, o bilhete está matematicamente perdido
          anyLost = true;
        }
      }

      if (anyLost) {
        // Vai direto para o Histórico como PERDEU no momento em que a primeira perna falha
        slip.status = 'perdeu';
        slip.resolvedAt = now;
        dirty = true;
      } else if (allResolved) {
        // Se todas as pernas finalizaram e todas acertaram, GANHOU
        slip.status = 'ganhou';
        slip.resolvedAt = now;
        dirty = true;
      } else {
        // VENCEU/EXPIROU: passou o último pontapé inicial + tolerância e ainda não
        // houve resolução completa (jogo adiado/abandonado/sem placar real).
        const lastKickoff = slip.legs.reduce((max, l) => Math.max(max, l.kickoffAt || 0), 0);
        const deadline = Math.max(lastKickoff, slip.expiresAt || 0) + graceMs;
        if (now > deadline) {
          slip.status = 'expirado';
          slip.resolvedAt = now;
          dirty = true;
        }
      }

      if (dirty) {
        bilheteriaDb.upsertSlip(slip);
        updated.push(slip);
      }
    }

    return { updatedSlips: updated };
  }

  public addCustomSlip(slip: BetSlip): BetSlip {
    if (!slip.dayKey) slip.dayKey = getDayKey(slip.createdAt || Date.now());
    this.slips.unshift(slip);
    bilheteriaDb.upsertSlip(slip);
    return slip;
  }

  /** Limpa todos os bilhetes (usado no reset — pernas antigas ficam órfãs). */
  public clearSlips(): void {
    this.slips = [];
    bilheteriaDb.deleteAllSlips();
  }
}

export const ticketEngine = new TicketEngine();
