/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BetSlip, MatchItem, MarketType, SlipScope, SlipTier } from './types.js';
import {
  marketService,
  leaguePriorityRank,
  isObscureLeague,
  isMainLeague,
  deriveCompleteOdds,
  MARKET_LABELS,
} from './marketService.js';
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

// Ficha maluca: poucos jogos, mercados de odd alta e combinada acima de 1000x.
const MALUCA_MIN_ODDS = 1000;
const MALUCA_MIN_LEGS = 4;
const MALUCA_MAX_LEGS = 6;
// Mercados de odd alta usados na Ousada (risco controlado) e na Maluca.
const HIGH_ODDS_MARKETS: MarketType[] = [
  'home',
  'draw',
  'away',
  'over25',
  'over35',
  'btts_yes',
  'btts_no',
  'under25',
  'under35',
  'dnb_home',
  'dnb_away',
];

// Liga obscura (feminino/base/exótica) vale pouco na ordenação.
const OBSCURE_PENALTY = 0.55;

/** Score de ordenação: probabilidade calibrada × peso da liga (obscura penalizada). */
function pickScore(m: MatchItem): number {
  return m.tip.prob * leagueWeight(m.league, m.competitionId) * (isObscureLeague(m.league) ? OBSCURE_PENALTY : 1);
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
  ousada: { min: 28, max: 48, color: 'var(--red-tier, #D1594B)', hex: '#D1594B' },
  maluca: { min: 0, max: 28, color: 'var(--violet-tier, #C084FC)', hex: '#C084FC' },
};

// Configuração de pernas por categoria e longevidade.
// Moderada e Ousada acumulam pontos com MAIS jogos e odds individuais
// controladas — não com poucas pernas de odd altíssima.
export const LEGS_CONFIG: Record<SlipScope, Record<SlipTier, number>> = {
  dia: { segura: 2, moderada: 5, ousada: 5, maluca: 5 },
  '2_3_dias': { segura: 3, moderada: 5, ousada: 6, maluca: 5 },
  longo: { segura: 3, moderada: 5, ousada: 6, maluca: 5 },
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
  // Quatro vagas = uma ficha de cada tier (segura, moderada, ousada e maluca).
  dia: envInt('TICKETS_QUOTA_DIA', 4),
  '2_3_dias': envInt('TICKETS_QUOTA_MED', 4),
  longo: envInt('TICKETS_QUOTA_LONGO', 4),
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

    // Migração de segurança: fichas pendentes antigas foram construídas com
    // odds de fallback (2.10/3.20/3.40) e nunca foram enviadas. Essas odds
    // sintéticas não podem continuar a ser apresentadas como mercado real;
    // descartamos apenas as que não têm registo de submissão. As que já foram
    // enviadas para a Premier Bet ficam no histórico (há dinheiro envolvido).
    const uploadedIds = new Set(bilheteriaDb.getUploads().map((u) => u.slipId));
    const syntheticPending = this.slips.filter(
      (slip) =>
        slip.status === 'pendente' &&
        !uploadedIds.has(slip.id) &&
        slip.legs.some((leg) => !leg.odds?.realMarkets)
    );
    if (syntheticPending.length > 0) {
      const ids = new Set(syntheticPending.map((slip) => slip.id));
      this.slips = this.slips.filter((slip) => !ids.has(slip.id));
      bilheteriaDb.deleteSlips([...ids]);
      console.log(
        `[Bilheteria] ${syntheticPending.length} ficha(s) pendente(s) com odds sintéticas removida(s); serão regeneradas com odds reais.`
      );
    }

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

    // Prefere ligas principais. Com odds reais o pool pode ser pequeno; nesse
    // caso completa com outras competições masculinas (femininos/base já
    // ficaram de fora na ingestão). A ordenação continua a dar prioridade
    // às ligas grandes, mas evita ficar sem fichas por falta de 20 pernas.
    const mainEligible = filtered.filter((m) => isMainLeague(m.league, m.competitionId));
    const eligible = mainEligible.length >= 16 ? mainEligible : filtered;

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

    // Separação em Buckets de Probabilidade (Segura, Moderada, Ousada, Maluca)
    const buckets: Record<SlipTier, MatchItem[]> = {
      segura: [],
      moderada: [],
      ousada: [],
      maluca: [],
    };

    evaluatedMatches.forEach((m) => {
      if (m.tip.prob >= TIERS_CONFIG.segura.min) {
        buckets.segura.push(m);
      } else if (m.tip.prob >= TIERS_CONFIG.moderada.min) {
        buckets.moderada.push(m);
      } else if (m.tip.prob >= TIERS_CONFIG.ousada.min) {
        buckets.ousada.push(m);
      } else {
        buckets.maluca.push(m);
      }
    });

    // NÃO apagar fichas pendentes existentes: elas persistem até resolverem ou
    // expirarem. A geração apenas acrescenta novas oportunidades ao estoque.

    const candidateSlips: BetSlip[] = [];
    const legsMap = LEGS_CONFIG[scope];

    // Jogos já usados noutro bilhete: cada construção prefere pernas frescas
    // para os bilhetes não saírem todos iguais.
    const usedIds = new Set<string>();
    const claim = (legs: MatchItem[]): void => {
      legs.forEach((l) => usedIds.add(l.id));
    };

    /**
     * Converte um jogo para a melhor odd de mercado dentro de uma janela.
     * Usado na Ousada e na Maluca para sair das tips "seguras" do motor e
     * montar múltiplas com odds mais altas. A probabilidade é a implícita
     * no preço (100 / odd), não a calibração Jev.
     */
    const toMarketOddsLeg = (
      m: MatchItem,
      minOdds: number,
      maxOdds: number
    ): MatchItem | null => {
      const marketOdds = deriveCompleteOdds(m.odds);
      let best: { market: MarketType; odds: number; prob: number; label: string } | null = null;
      const realMarkets = m.odds.realMarkets;
      const allowedMarkets = realMarkets
        ? HIGH_ODDS_MARKETS.filter((market) => realMarkets.includes(market))
        : HIGH_ODDS_MARKETS.filter(
            (market) => market === 'home' || market === 'draw' || market === 'away'
          );

      for (const market of allowedMarkets) {
        const odd = Number(marketOdds[market]);
        if (!Number.isFinite(odd) || odd < minOdds || odd > maxOdds) continue;
        if (!best || odd > best.odds) {
          const labelFn = MARKET_LABELS[market];
          best = {
            market,
            odds: odd,
            prob: Math.max(4, Math.min(45, Math.round(100 / odd))),
            label: labelFn ? labelFn({ home: m.home, away: m.away }) : market,
          };
        }
      }

      if (!best) return null;
      return {
        ...m,
        tip: {
          market: best.market,
          label: best.label,
          odds: best.odds,
          prob: best.prob,
        },
        jevInference: undefined,
      };
    };

    const pickDiverse = (ordered: MatchItem[], target: number): MatchItem[] => {
      const picked: MatchItem[] = [];
      const leagues = new Set<string>();
      for (const m of ordered) {
        if (picked.length >= target) break;
        if (picked.some((l) => l.id === m.id)) continue;
        if (leagues.has(m.league)) {
          const hasAlternative = ordered.some(
            (x) => !picked.some((l) => l.id === x.id) && !leagues.has(x.league)
          );
          if (hasAlternative) continue;
        }
        picked.push(m);
        leagues.add(m.league);
      }
      return picked;
    };

    /**
     * Constrói Moderada/Ousada com MUITAS pernas e odds de mercado numa janela
     * controlada. A probabilidade exibida é a implícita (100 / odd), porque
     * estas pernas não são a recomendação calibrada do Jev.
     */
    const buildMarketTier = (
      tier: 'moderada' | 'ousada',
      quantity: number,
      minOdds: number,
      maxOdds: number
    ): BetSlip | null => {
      const oddsDesc = (a: MatchItem, b: MatchItem) => b.tip.odds - a.tip.odds;
      const toLegs = (source: MatchItem[], low: number, high: number): MatchItem[] =>
        source
          .map((m) => toMarketOddsLeg(m, low, high))
          .filter((m): m is MatchItem => m !== null);

      const buildOrdered = (low: number, high: number): MatchItem[] => {
        const fresh = orderTopFirst(
          toLegs(evaluatedMatches.filter((m) => !usedIds.has(m.id)), low, high),
          oddsDesc
        );
        const reuse = orderTopFirst(
          toLegs(evaluatedMatches.filter((m) => usedIds.has(m.id)), low, high),
          oddsDesc
        );
        return [...fresh, ...reuse];
      };

      let ordered = buildOrdered(minOdds, maxOdds);
      if (ordered.length < quantity) {
        // Relaxa a janela só o suficiente para completar o número de jogos.
        ordered = buildOrdered(Math.max(1.5, minOdds - 0.15), maxOdds + 0.2);
      }
      if (ordered.length < 4) return null;

      let legs = pickDiverse(ordered, quantity);
      if (legs.length < quantity) {
        legs = pickDiverse(ordered, Math.max(4, quantity - 1));
      }
      if (legs.length < 4) return null;

      const duplicate = candidateSlips.some(
        (s) =>
          s.legs.length === legs.length &&
          s.legs.every((l) => legs.some((x) => x.id === l.id))
      );
      if (duplicate) return null;

      const combinedOdds = legs.reduce((acc, l) => acc * l.tip.odds, 1);
      const maxLegOdds = Math.max(...legs.map((l) => l.tip.odds));
      const label = tier === 'moderada' ? 'Moderada' : 'Ousada';
      return this.createSlip(scope, tier, legs, {
        customTitle: `Múltipla ${label} (${legs.length} jogos • ${combinedOdds.toFixed(2)}x)`,
        rationale: `Ficha ${tier} com ${legs.length} jogos e odds individuais até ${maxLegOdds.toFixed(2)}. Os pontos acumulam pelo número de jogos, não por pernas de odd altíssima. Probabilidades implícitas no mercado.`,
        isAiGenerated: false,
      });
    };

    // 1. Bilhetes Seguros (ligas principais primeiro, probabilidades coerentes)
    const sortedSegura = orderTopFirst(
      [...(buckets.segura.length >= 2 ? buckets.segura : evaluatedMatches)],
      (a, b) => pickScore(b) - pickScore(a)
    );
    const seguraLegs = takeCoherent(sortedSegura, legsMap.segura, usedIds, 58);
    if (seguraLegs.length >= legsMap.segura) {
      candidateSlips.push(
        this.createSlip(scope, 'segura', ensureTopTierLegs(seguraLegs, sortedSegura))
      );
      claim(seguraLegs);
    }

    // 2. Moderada: 5 jogos com odds de mercado entre 1.80 e 2.15.
    // Janela baixa o suficiente para não repetir as pernas de 3.50, mas alta
    // o suficiente para os pontos crescerem pelo número de jogos.
    const moderada = buildMarketTier('moderada', legsMap.moderada, 1.8, 2.15);
    if (moderada) {
      candidateSlips.push(moderada);
      claim(moderada.legs);
    }

    // 3. Ousada: 5-6 jogos, janela de mercado acima da moderada.
    const ousada = buildMarketTier('ousada', legsMap.ousada, 2.15, 3.0);
    if (ousada) {
      candidateSlips.push(ousada);
      claim(ousada.legs);
    }

    /**
     * Ficha Maluca: poucos jogos (4 a 6), mercados de odd alta e combinada
     * acima de 1000x. Usa a melhor odd disponível por jogo e estima a
     * probabilidade pelo próprio preço de mercado (100 / odd).
     */
    const buildMalucaVariant = (): BetSlip | null => {
      const fresh = evaluatedMatches.filter((m) => !usedIds.has(m.id));
      const source = fresh.length >= MALUCA_MIN_LEGS ? fresh : evaluatedMatches;
      const candidates = source
        .map((m) => toMarketOddsLeg(m, 3.0, Number.POSITIVE_INFINITY))
        .filter((m): m is MatchItem => m !== null);
      if (candidates.length < MALUCA_MIN_LEGS) return null;

      const ordered = orderTopFirst(candidates, (a, b) => b.tip.odds - a.tip.odds);
      let legs = pickDiverse(ordered, MALUCA_MIN_LEGS);
      let combinedOdds = legs.reduce((acc, l) => acc * l.tip.odds, 1);
      for (
        let target = MALUCA_MIN_LEGS + 1;
        target <= MALUCA_MAX_LEGS && combinedOdds < MALUCA_MIN_ODDS;
        target++
      ) {
        legs = pickDiverse(ordered, target);
        combinedOdds = legs.reduce((acc, l) => acc * l.tip.odds, 1);
      }

      if (legs.length < MALUCA_MIN_LEGS || combinedOdds < MALUCA_MIN_ODDS) {
        return null;
      }

      return this.createSlip(scope, 'maluca', legs, {
        customTitle: `Ficha Maluca (${legs.length} jogos • ${combinedOdds.toFixed(2)}x)`,
        rationale: `Ficha maluca: ${legs.length} jogos de alto risco e odd combinada de ${combinedOdds.toFixed(2)}x. As probabilidades individuais são estimadas pelas odds do mercado; risco máximo.`,
        isAiGenerated: false,
      });
    };

    const maluca = buildMalucaVariant();
    if (maluca) {
      candidateSlips.push(maluca);
      claim(maluca.legs);
    }

    // REGRA DE NEGÓCIO: reter bilhetes COERENTES (probabilidades próximas,
    // ligas diversificadas), não apenas os de maior pontuação/odd.
    const existingPending = this.slips.filter(
      (s) => s.scope === scope && s.status === 'pendente'
    );
    const existingByTier: Record<SlipTier, number> = {
      segura: 0,
      moderada: 0,
      ousada: 0,
      maluca: 0,
    };
    existingPending.forEach((s) => {
      existingByTier[s.tier] += 1;
    });

    const tierOrder: SlipTier[] = ['segura', 'moderada', 'ousada', 'maluca'];
    const tierPriority = [...tierOrder].sort(
      (a, b) =>
        existingByTier[a] - existingByTier[b] ||
        tierOrder.indexOf(a) - tierOrder.indexOf(b)
    );
    const byTier: Record<SlipTier, BetSlip[]> = {
      segura: [],
      moderada: [],
      ousada: [],
      maluca: [],
    };
    candidateSlips.forEach((s) => byTier[s.tier].push(s));
    tierOrder.forEach((tier) => {
      byTier[tier].sort((a, b) =>
        tier === 'maluca'
          ? b.combinedOdds - a.combinedOdds
          : legsCoherence(b.legs) - legsCoherence(a.legs)
      );
    });

    // Um candidato de cada tier primeiro (priorizando o tier mais em falta),
    // depois as segundas variações. Assim a quota de 4 rende uma ficha de
    // cada categoria em vez de duas seguras + uma moderada.
    const finalSlips: BetSlip[] = [];
    tierPriority.forEach((tier) => {
      if (byTier[tier][0]) finalSlips.push(byTier[tier][0]);
    });
    tierPriority.forEach((tier) => {
      for (let i = 1; i < byTier[tier].length; i++) finalSlips.push(byTier[tier][i]);
    });

    // Evita repetir pernas de fichas que já estão no estoque pendente do mesmo
    // horizonte. Se não houver candidatos totalmente frescos, aceita os que não
    // sejam exatamente iguais a uma ficha existente (mercado pode estar curto).
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

    // Frescas primeiro, mas completa com as restantes distintas em vez de
    // descartar tudo só porque uma perna já existe noutra ficha pendente.
    const candidatePool = [
      ...freshCandidates,
      ...notIdentical.filter((s) => !freshCandidates.includes(s)),
    ];
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
