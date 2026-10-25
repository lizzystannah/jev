/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BetSlip, MatchItem, MarketType, SlipEngine, SlipScope, SlipTier } from './types.js';
import {
  marketService,
  leaguePriorityRank,
  isObscureLeague,
  isMainLeague,
  oddsSignature,
  marketOutcomeFor,
} from './marketService.js';
import {
  callLocalInferenceEngine,
  type LocalDecisionInput,
} from './aiscoreEngine.js';
import { jevChooseMarkets } from './jevEngine.js';
import { aiscoreClient } from './aiscoreService.js';
import { resolvePremierBetOdds } from './premierbetOdds.js';
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

// Liga obscura (feminino/base/exÃ³tica) vale pouco na ordenaÃ§Ã£o.
const OBSCURE_PENALTY = 0.55;

/** Score de ordenaÃ§Ã£o: probabilidade calibrada Ã— peso da liga (obscura penalizada). */
function pickScore(m: MatchItem): number {
  return m.tip.prob * leagueWeight(m.league, m.competitionId) * (isObscureLeague(m.league) ? OBSCURE_PENALTY : 1);
}

/**
 * Ligas principais primeiro: ordena cada grupo pelo critÃ©rio e concatena
 * top-tier antes do resto. Bilhetes saem com ligas grandes; as estranhas
 * sÃ³ entram para completar quando faltam jogos principais.
 */
function orderTopFirst(arr: MatchItem[], sortFn: (a: MatchItem, b: MatchItem) => number): MatchItem[] {
  const top = arr.filter((m) => isTopTierLeague(m.league, m.competitionId)).sort(sortFn);
  const rest = arr.filter((m) => !isTopTierLeague(m.league, m.competitionId)).sort(sortFn);
  return [...top, ...rest];
}

/**
 * CoerÃªncia de um conjunto de pernas: probabilidades prÃ³ximas, ligas
 * diversificadas, presenÃ§a de ligas principais e odds sem exagero.
 * Serve para escolher bilhetes equilibrados em vez de sÃ³ os de maior score.
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
 * Escolhe tips por ordem de prioridade atÃ© a odd combinada atingir o alvo.
 * A ordem jÃ¡ vem das tips de maior probabilidade; por isso o alvo Ã© alcanÃ§ado
 * com mais jogos e odds individuais mais baixas, nÃ£o com pernas artificiais.
 * Prefere uma liga diferente por perna enquanto houver alternativa.
 */
function pickUntilTarget(
  ordered: MatchItem[],
  cfg: { targetOdds: number; maxLegs: number; minLegs: number },
  diversifyLeagues = true
): MatchItem[] | null {
  const picked: MatchItem[] = [];
  const leagues = new Set<string>();

  const product = (): number => picked.reduce((acc, leg) => acc * leg.tip.odds, 1);

  for (const match of ordered) {
    if (picked.length >= cfg.maxLegs) break;
    if (picked.some((leg) => leg.id === match.id)) continue;

    if (diversifyLeagues && leagues.has(match.league)) {
      const hasAlternative = ordered.some(
        (candidate) =>
          !picked.some((leg) => leg.id === candidate.id) &&
          !leagues.has(candidate.league)
      );
      if (hasAlternative) continue;
    }

    picked.push(match);
    leagues.add(match.league);

    if (picked.length >= cfg.minLegs && product() >= cfg.targetOdds) {
      return picked;
    }
  }

  return picked.length >= cfg.minLegs && product() >= cfg.targetOdds ? picked : null;
}

export const TIERS_CONFIG = {
  segura: { min: 63, max: 101, color: 'var(--green-tier, #4FAE73)', hex: '#4FAE73' },
  moderada: { min: 48, max: 63, color: 'var(--amber-tier, #E7B33E)', hex: '#E7B33E' },
  ousada: { min: 28, max: 48, color: 'var(--red-tier, #D1594B)', hex: '#D1594B' },
  maluca: { min: 0, max: 28, color: 'var(--violet-tier, #C084FC)', hex: '#C084FC' },
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Alvo de odd combinada ("pontos") por tier. A ficha pega nas tips jÃ¡
 * calculadas para os jogos e acrescenta o nÃºmero de jogos necessÃ¡rio para
 * chegar ao alvo. Nunca inventa uma odd alta sÃ³ para preencher pontos.
 *
 * Exemplos: moderada 15x, ousada 100x, maluca 1000x.
 */
export const TICKET_TARGETS: Record<
  SlipTier,
  { targetOdds: number; maxLegs: number; minLegs: number; label: string }
> = {
  segura: {
    targetOdds: envFloat('TICKETS_TARGET_SEGURA', 3),
    maxLegs: envInt('TICKETS_MAX_LEGS_SEGURA', 12),
    minLegs: 2,
    label: 'Segura',
  },
  moderada: {
    targetOdds: envFloat('TICKETS_TARGET_MODERADA', 15),
    maxLegs: envInt('TICKETS_MAX_LEGS_MODERADA', 18),
    minLegs: 2,
    label: 'Moderada',
  },
  ousada: {
    targetOdds: envFloat('TICKETS_TARGET_OUSADA', 100),
    maxLegs: envInt('TICKETS_MAX_LEGS_OUSADA', 26),
    minLegs: 2,
    label: 'Ousada',
  },
  maluca: {
    targetOdds: envFloat('TICKETS_TARGET_MALUCA', 1000),
    maxLegs: envInt('TICKETS_MAX_LEGS_MALUCA', 8),
    minLegs: 4,
    label: 'Maluca',
  },
};

/**
 * Fichas de LONGO PRAZO: mÃ­nimo de 10 e mÃ¡ximo de 22 jogos (configurÃ¡vel).
 * O alvo de odd continua a mandar no momento de parar, mas nunca abaixo do
 * mÃ­nimo â€” por isso as fichas longas acumulam mais jogos em vez de poucas
 * pernas de odd alta. Segura/moderada/ousada variam o mÃ­nimo dentro da faixa.
 */
export const LONGO_MIN_LEGS = envInt('TICKETS_LONGO_MIN_LEGS', 10);
export const LONGO_MAX_LEGS = Math.max(
  LONGO_MIN_LEGS,
  envInt('TICKETS_LONGO_MAX_LEGS', 22)
);
/**
 * Longo prazo Ã© uma seleÃ§Ã£o mais rigorosa: sÃ³ tips com probabilidade >= 55%
 * (default), aproveitando os melhores jogos de HOJE atÃ© +8 dias â€” nÃ£o apenas
 * os que acontecem daqui a 4+ dias.
 */
export const LONGO_MIN_PROB = Math.min(
  95,
  Math.max(0, envInt('TICKETS_LONGO_MIN_PROB', 55))
);

/**
 * Teto de odd por perna nas fichas Segura/Moderada/Ousada. A pontuaÃ§Ã£o alta
 * desses tiers vem de ACUMULAR jogos de odd baixa, nunca de uma perna de odd
 * alta. SÃ³ a Maluca pode usar odds altas (highRiskTip).
 */
export const MAX_LEG_ODD = Math.max(1.01, envFloat('TICKETS_MAX_LEG_ODD', 2.2));
/** Odd minima por perna nos tiers nao-Maluca (evita acumular 1.05/1.10). */
export const MIN_LEG_ODD = Math.max(1.01, envFloat('TICKETS_MIN_LEG_ODD', 1.25));

/**
 * Anti-correlação entre fichas: um jogo pode aparecer em no máximo N fichas
 * pendentes. Se tiver de repetir, usa OBRIGATORIAMENTE outro mercado (tip).
 */
export const MAX_SLIPS_PER_MATCH = Math.max(
  1,
  envInt('TICKETS_MAX_SLIPS_PER_MATCH', 2)
);
/** Máximo de pernas repetidas (com tip diferente) por ficha. */
export const MAX_REUSED_LEGS = Math.max(0, envInt('TICKETS_MAX_REUSED_LEGS', 2));

/** Config efetiva de pernas por tier e escopo (longo tem faixa prÃ³pria). */
function legsConfigFor(
  scope: SlipScope,
  tier: SlipTier
): { targetOdds: number; maxLegs: number; minLegs: number; label: string } {
  const base = TICKET_TARGETS[tier];
  if (scope !== 'longo') return base;
  const extra =
    tier === 'ousada' ? 8 : tier === 'moderada' ? 4 : tier === 'maluca' ? 0 : 0;
  const minLegs = Math.min(
    LONGO_MAX_LEGS,
    Math.max(base.minLegs, LONGO_MIN_LEGS + extra)
  );
  return {
    ...base,
    minLegs,
    maxLegs: Math.max(minLegs, LONGO_MAX_LEGS),
  };
}

/**
 * Estoque mÃ­nimo de fichas PENDENTES por horizonte.
 * O agendador repÃµe automaticamente sempre que uma ficha cai (ganha/perde/expira)
 * ou quando a mudanÃ§a do dia cria a nova fornada de "Hoje".
 */
export const SCOPE_QUOTAS: Record<SlipScope, number> = {
  // Quatro vagas = uma ficha de cada tier (segura, moderada, ousada e maluca).
  dia: envInt('TICKETS_QUOTA_DIA', 4),
  '2_3_dias': envInt('TICKETS_QUOTA_MED', 4),
  longo: envInt('TICKETS_QUOTA_LONGO', 4),
};

/** Teto de seguranÃ§a para o botÃ£o manual "Gerar" nÃ£o inundar o estoque. */
export const SCOPE_MAX_PENDING: Record<SlipScope, number> = {
  dia: SCOPE_QUOTAS.dia + 2,
  '2_3_dias': SCOPE_QUOTAS['2_3_dias'] + 2,
  longo: SCOPE_QUOTAS.longo + 2,
};

/** Horas de tolerÃ¢ncia apÃ³s o Ãºltimo pontapÃ© inicial antes de marcar como vencida. */
export const EXPIRY_GRACE_HOURS = envInt('TICKETS_EXPIRY_GRACE_HOURS', 6);

export interface GenerateOptions {
  /** MÃ¡ximo de fichas novas a devolver nesta geraÃ§Ã£o (default: 5). */
  limit?: number;
  /**
   * Tipo de tip forÃ§ado (ex.: 'over35', 'double_chance_1x'). Quando definido,
   * o motor calcula ESSE mercado para todos os jogos do escopo e monta a ficha
   * sÃ³ com ele. Sem preÃ§o real no feed, tenta obter a odd na Premier Bet.
   */
  market?: MarketType;
  /**
   * Motor que decide as tips: 'local' (padrÃ£o, faixa de probabilidade) ou
   * 'jev' (o modelo de decisÃ£o escolhe o mercado de cada jogo a partir das
   * probabilidades jÃ¡ calculadas pelo motor local).
   */
  engine?: SlipEngine;
}

/** Telemetria da geraÃ§Ã£o JEV (chamadas reais vs decisÃµes reaproveitadas). */
export interface JevGenerationMeta {
  reused: number;
  newPicks: number;
  apiCalls: number;
  costUsd: number;
  /** DecisÃµes antigas descartadas por o mercado jÃ¡ nÃ£o estar entre as candidatas. */
  stale: number;
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
   * Carrega as fichas persistidas para memÃ³ria. Deve ser chamado uma Ãºnica vez
   * no arranque, depois de `bilheteriaDb.init()`.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    // As fichas persistidas sÃ£o a fonte de verdade: NÃƒO se apaga nenhuma no
    // arranque (nem por odds antigas, nem por alvo de tier desatualizado).
    // Fichas existentes sobrevivem a restart/redeploy desde que a base de
    // dados esteja num volume (ver docker-compose.yml / MySQL).
    this.slips = await bilheteriaDb.loadSlips();
    // Corrige resultados antigos calculados com o tip do match em vez do tip
    // da perna (fichas resolveram "Acertou" com mercados diferentes).
    this.repairLegResults();

    // Continua a numeraÃ§Ã£o a partir da Ãºltima ficha persistida (evita IDs repetidos).
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
    options?: {
      customTitle?: string;
      rationale?: string;
      isAiGenerated?: boolean;
      engine?: SlipEngine;
    }
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
      engine: options?.engine ?? 'local',
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
   * Pipeline de criaÃ§Ã£o com o motor LOCAL AiScore (sem Jev, sem OpenRouter):
   * 1. Filtra os jogos por janela: dia=hoje; 2_3_dias=hoje..+3; longo=hoje..+8
   *    (longo Ã© mais rigoroso: sÃ³ tips com prob >= TICKETS_LONGO_MIN_PROB)
   * 2. Enriquece com o scout COMPLETO do AiScore (H2H, forma, trends, janelas de golo, odds)
   * 3. O motor local calcula xG (Poisson) + taxas empÃ­ricas + H2H + mando e
   *    devolve, para CADA jogo, a melhor tip por faixa de probabilidade â€”
   *    determinÃ­stico, sem EV na escolha
   * 4. Todos os jogos avaliados ficam na pool; segura/moderada/ousada sÃ£o
   *    alvos de odd combinada TOTAL e se diferenciam pelo NÃšMERO de jogos
   *    acumulados (nunca por inventar odds ou trocar tip por jogo)
   */
  public async generateTicketsForScope(
    scope: SlipScope,
    activeLeagues?: string[],
    options?: GenerateOptions
  ): Promise<{
    generated: BetSlip[];
    all: BetSlip[];
    jevLatencyMs: number;
    jevMeta?: JevGenerationMeta;
  }> {
    const allMatches = await marketService.getMatches();

    // Filtro estrito do horizonte de longevidade e proteÃ§Ã£o absoluta contra jogos passados
    const now = Date.now();
    const filtered = allMatches.filter((m) => {
      const matchLeague = !activeLeagues || activeLeagues.length === 0 || activeLeagues.includes(m.league);
      const notResolved = m.status !== 'resolved';
      const isFutureMatch = m.kickoffAt > now; // Jamais criar bilhetes com jogos passados ou iniciados

      let matchScopeMatches = false;
      if (scope === 'dia') {
        matchScopeMatches = m.daysFromNow === 0;
      } else if (scope === '2_3_dias') {
        // Inclui HOJE e os prÃ³ximos 3 dias (nÃ£o sÃ³ 1..3).
        matchScopeMatches = m.daysFromNow >= 0 && m.daysFromNow <= 3;
      } else {
        // Longo prazo: os MELHORES jogos de hoje atÃ© +8 dias (janela ~1 semana),
        // com probabilidade mÃ­nima mais alta. NÃ£o Ã© sÃ³ "daqui a 4+ dias".
        matchScopeMatches = m.daysFromNow >= 0 && m.daysFromNow <= 8;
      }

      return matchLeague && matchScopeMatches && notResolved && isFutureMatch;
    });

    // O motor calcula uma tip para TODOS os jogos com odds reais do horizonte.
    // As fichas sÃ£o montadas depois, escolhendo entre essas tips; nunca se
    // inventa uma odd alta para "completar pontos".
    const mainEligible = filtered.filter((m) => isMainLeague(m.league, m.competitionId));
    const tipPool = filtered;

    if (tipPool.length === 0) {
      return { generated: [], all: this.slips, jevLatencyMs: 0 };
    }

    // Odds reais para os mercados que o feed do AiScore nÃ£o cobre. Isto inclui
    // o 1X2 dos jogos futuros que vÃªm SEM odds do feed (eram descartados e
    // deixavam o longo prazo sem mercado). Com tip forÃ§ada, sÃ³ esse mercado.
    const forcedMarket = options?.market;
    const BASE_MARKETS: MarketType[] = ['home', 'draw', 'away'];
    const EXTRA_MARKETS: MarketType[] = [
      'double_chance_1x', 'double_chance_x2', 'over15',
      'over35', 'under35', 'dnb_home', 'dnb_away',
    ];
    const enrichMarkets = forcedMarket
      ? [forcedMarket]
      : [...BASE_MARKETS, ...EXTRA_MARKETS];
    const enrichEnabled = forcedMarket || process.env.PREMIERBET_ENRICH !== '0';
    if (enrichEnabled) {
      const missing = (m: (typeof filtered)[number]): boolean => {
        const rm = m.odds.realMarkets;
        return enrichMarkets.some((mk) => !rm?.includes(mk));
      };
      // SÃ³ ligas da whitelist entram nas fichas â€” nÃ£o vale a pena consultar a
      // Premier Bet por ligas que nÃ£o podem ser usadas. Ordena por prioridade
      // de liga e kickoff (o pickScore Ã© 0 nos jogos ainda sem odds).
      const cap = forcedMarket ? 50 : scope === 'longo' ? 80 : 40;
      const need = filtered
        .filter((m) => isMainLeague(m.league, m.competitionId) && missing(m))
        .sort((a, b) => {
          const ba = a.odds.realMarkets?.includes('home') ? 1 : 0;
          const bb = b.odds.realMarkets?.includes('home') ? 1 : 0;
          if (ba !== bb) return ba - bb; // primeiro os que estÃ£o SEM odds
          const la = leaguePriorityRank(a.league, a.competitionId);
          const lb = leaguePriorityRank(b.league, b.competitionId);
          return la - lb || a.kickoffAt - b.kickoffAt;
        })
        .slice(0, cap);
      if (need.length > 0) {
        // Em lotes de 25: cada lote Ã© um processo Python com timeout prÃ³prio,
        // para um dia lento nÃ£o perder o enriquecimento inteiro.
        const chunkSize = 25;
        let filled = 0;
        for (let start = 0; start < need.length; start += chunkSize) {
          const chunk = need.slice(start, start + chunkSize);
          try {
            const pb = await resolvePremierBetOdds(
              chunk.map((m) => ({
                home: m.home,
                away: m.away,
                kickoffAt: m.kickoffAt,
                date: m.dateStr,
                markets: enrichMarkets,
              })),
              60_000
            );
            chunk.forEach((m, i) => {
              const result =
                pb.results[i] ??
                pb.results.find(
                  (r) =>
                    r.home.trim().toLowerCase() === m.home.trim().toLowerCase() &&
                    r.away.trim().toLowerCase() === m.away.trim().toLowerCase()
                );
              if (!result) return;
              const real = new Set(m.odds.realMarkets || []);
              for (const mk of enrichMarkets) {
                const odd = result.odds?.[mk];
                if (typeof odd === 'number' && Number.isFinite(odd) && odd > 1.01) {
                  (m.odds as any)[mk] = Number(odd.toFixed(2));
                  real.add(mk);
                  filled += 1;
                }
              }
              m.odds.realMarkets = Array.from(real);
            });
          } catch (err: any) {
            console.warn('[PremierBet] lote de enriquecimento falhou:', err?.message);
          }
        }
        if (filled > 0) {
          console.log(
            `[PremierBet] ${filled} odd(s) real(is) anexada(s) ao motor` +
              (forcedMarket ? ` (mercado "${forcedMarket}").` : ' (1X2 + mercados extra).')
          );
        }
      }
    }

    // Enriquece com o scout COMPLETO do AiScore (todas as variÃ¡veis) antes
    // do motor local â€” falha nÃ£o bloqueia (o motor usa o contexto resumido).
    // Damos prioridade Ã s ligas que podem entrar nas fichas; o resto recebe
    // a tip de mercado, sem preÃ§o sintÃ©tico.
    // includeLineups sÃ³ no dia: escalaÃ§es sÃ³ existem perto do pontapÃ© inicial.
    const wantLineups = scope === 'dia';
    const enrichmentPool = mainEligible.length > 0 ? mainEligible : tipPool;
    try {
      const n = await aiscoreClient.enrichMatches(enrichmentPool, { maxMatches: 6, deadlineMs: 18_000, includeLineups: wantLineups });
      if (n > 0) {
        console.log(`[AiScore] ${n} partida(s) com scout completo anexado ao motor local.`);
      }
      void aiscoreClient
        .enrichMatches(enrichmentPool, { maxMatches: 40, deadlineMs: 90_000, includeLineups: wantLineups })
        .catch(() => undefined);
    } catch (err: any) {
      console.warn('[AiScore] Enriquecimento de contexto falhou (motor local segue com odds):', err?.message);
    }

    // Prepara a entrada do motor local (scout completo + odds) para todos os
    // jogos do horizonte. Assim existe uma tip prÃ©-calculada para cada jogo.
    const horizonDays = scope === 'dia' ? 0 : scope === '2_3_dias' ? 3 : 7;
    const localInput: LocalDecisionInput = {
      scope,
      horizonDays,
      matches: tipPool.map((m) => ({
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
        forcedMarket: options?.market,
      })),
    };

    // InferÃªncia local determinÃ­stica (sem rede, sem chave)
    const localResponse = await callLocalInferenceEngine(localInput);
    this.lastJevLatencyMs = localResponse.latencyMs;

    // Atualiza cada partida no pool com a probabilidade calibrada local
    const matchEvaluationsMap = new Map(localResponse.evaluations.map((e) => [e.matchId, e]));

    // DecisÃµes JEV persistidas (assinatura de odds ainda vÃ¡lida) tÃªm de ser
    // capturadas ANTES de a calibraÃ§Ã£o local ser reescrita abaixo.
    type StoredJevPick = NonNullable<
      NonNullable<MatchItem['calibration']>['jevPick']
    >;
    const persistedJevPicks = new Map<string, StoredJevPick>();
    if (options?.engine === 'jev' && process.env.JEV_REUSE_DECISIONS !== '0') {
      for (const m of tipPool) {
        const cal = m.calibration;
        if (cal?.jevPick && cal.oddsHash === oddsSignature(m.odds)) {
          persistedJevPicks.set(m.id, cal.jevPick);
        }
      }
    }

    let evaluatedMatches: MatchItem[] = tipPool.map((m) => {
      const ev = matchEvaluationsMap.get(m.id);
      if (!ev) return m;

      // Anexa a inferÃªncia do motor local
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
      m.highRiskTip = ev.highRiskTip;

      // Persiste a calibraÃ§Ã£o (tips por mercado + assinatura de odds) para
      // sobreviver a restart/redeploy sem recalcular.
      m.calibration = {
        tips: ev.tips,
        recommendedMarket: ev.recommendedMarket,
        marketLabel: ev.marketLabel,
        calibratedProb: ev.calibratedProb,
        expectedValueEdge: ev.expectedValueEdge,
        highRiskTip: ev.highRiskTip,
        oddsHash: oddsSignature(m.odds),
        at: Date.now(),
      };
      m.tips = ev.tips;

      return m;
    });

    // Motor JEV: o LLM recebe sÃ³ o essencial (tips com prob do motor local +
    // odds reais) e escolhe UM mercado por jogo. As probabilidades continuam
    // a ser as do motor local; o JEV decide a tip.
    let jevMeta: JevGenerationMeta | undefined;
    if (options?.engine === 'jev') {
      const jev = await this.applyJevPicks(
        scope,
        evaluatedMatches,
        horizonDays,
        persistedJevPicks
      );
      evaluatedMatches = jev.matches;
      jevMeta = jev.meta;
      if (evaluatedMatches.length === 0) {
        return {
          generated: [],
          all: this.slips,
          jevLatencyMs: localResponse.latencyMs,
          jevMeta,
        };
      }
    }

    const selectionPoolBase = evaluatedMatches.filter(
      (m) =>
        isMainLeague(m.league, m.competitionId) &&
        m.tip &&
        m.tip.odds > 1.01 &&
        Number.isFinite(m.tip.prob)
    );
    // Longo prazo: seleÃ§Ã£o mais criteriosa (probabilidade mÃ­nima mais alta).
    const selectionPool =
      scope === 'longo'
        ? selectionPoolBase.filter((m) => m.tip.prob >= LONGO_MIN_PROB)
        : selectionPoolBase;

    if (selectionPool.length === 0) {
      console.warn(
        `[Fichas] ${scope}: ${filtered.length} jogo(s) na janela; nenhuma tip elegivel ` +
          `(odds ${MIN_LEG_ODD}-${MAX_LEG_ODD}).`
      );
      return { generated: [], all: this.slips, jevLatencyMs: localResponse.latencyMs };
    }

    // Os tiers NÃƒO sÃ£o divididos por probabilidade individual do jogo: cada
    // jogo entra com a MESMA tip (a de maior p na faixa "mÃ©dia" do motor).
    // Segura/Moderada/Ousada diferem sÃ³ no ALVO de pontuaÃ§Ã£o TOTAL da odd
    // combinada, alcanÃ§ado com o NÃšMERO de jogos necessÃ¡rio â€” nunca inventando
    // odds nem forÃ§ando tips de probabilidade diferente por jogo. SÃ³ a Maluca
    // usa tips de odd alta por jogo (highRiskTip, sempre mercado real).

    // NÃƒO apagar fichas pendentes existentes: elas persistem atÃ© resolverem ou
    // expirarem. A geraÃ§Ã£o apenas acrescenta novas oportunidades ao estoque.

    const candidateSlips: BetSlip[] = [];

    // Jogos jÃ¡ usados noutro bilhete: cada construÃ§Ã£o prefere pernas frescas
    // para os bilhetes nÃ£o saÃ­rem todos iguais.
    const usedIds = new Set<string>();
    const matchSlipCount = new Map<string, number>();
    const matchMarkets = new Map<string, Set<MarketType>>();
    for (const slip of this.slips) {
      if (slip.status !== 'pendente') continue;
      for (const leg of slip.legs) {
        matchSlipCount.set(leg.id, (matchSlipCount.get(leg.id) || 0) + 1);
        const markets = matchMarkets.get(leg.id) ?? new Set<MarketType>();
        markets.add(leg.tip.market);
        matchMarkets.set(leg.id, markets);
      }
    }
    const claim = (legs: MatchItem[]): void => {
      legs.forEach((l) => {
        usedIds.add(l.id);
        matchSlipCount.set(l.id, (matchSlipCount.get(l.id) || 0) + 1);
        const markets = matchMarkets.get(l.id) ?? new Set<MarketType>();
        markets.add(l.tip.market);
        matchMarkets.set(l.id, markets);
      });
    };

    /**
     * ConstrÃ³i uma ficha de um tier usando as tips jÃ¡ calculadas para os jogos.
     * A ordem Ã© por probabilidade (com peso da liga); acrescentam-se jogos atÃ©
     * a odd combinada chegar ao alvo. Se o tier nÃ£o tiver tips suficientes,
     * devolve null â€” nunca inventa uma perna de odd alta para "completar pontos".
     */
    const buildTargetTier = (
      tier: SlipTier,
      overrides?: {
        pool?: MatchItem[];
        sortFn?: (a: MatchItem, b: MatchItem) => number;
        /** Se false, pode reutilizar jogos jÃ¡ usados noutras fichas desde o inÃ­cio. */
        preferFresh?: boolean;
        /** Se false, permite vÃ¡rias pernas da mesma liga (mais jogos na Ousada). */
        diversifyLeagues?: boolean;
      }
    ): BetSlip | null => {
      const cfg = legsConfigFor(scope, tier);
      // Segura/Moderada/Ousada: só pernas de odd baixa (a pontuação alta vem
      // de acumular jogos). A Maluca é a única que pode usar odds altas.
      const primary = (overrides?.pool ?? selectionPool).filter(
        (m) => m.tip.odds > 1.01 &&
          (tier === 'maluca' ||
            (m.tip.odds >= MIN_LEG_ODD && m.tip.odds <= MAX_LEG_ODD))
      );
      if (primary.length < cfg.minLegs) return null;

      const sortFn = overrides?.sortFn ?? ((a, b) => pickScore(b) - pickScore(a));
      const tryPool = (pool: MatchItem[]): MatchItem[] | null =>
        pickUntilTarget(orderTopFirst(pool, sortFn), cfg, overrides?.diversifyLeagues !== false);

      // Prefere pernas frescas; se nÃ£o chegarem ao alvo, permite reutilizar
      // um jogo jÃ¡ usado noutra ficha (a tip continua a ser a mesma, real).
      const fresh = primary.filter((m) => (matchSlipCount.get(m.id) || 0) === 0);
      let legs = fresh.length >= cfg.minLegs ? tryPool(fresh) : null;

      if (!legs) {
        // Repeticao controlada: no maximo MAX_REUSED_LEGS jogos ja usados e,
        // em cada um, um mercado/tip DIFERENTE dos ja usados noutras fichas.
        const repeats: MatchItem[] = [];
        for (const m of primary) {
          if (repeats.length >= MAX_REUSED_LEGS) break;
          const count = matchSlipCount.get(m.id) || 0;
          if (count === 0 || count >= MAX_SLIPS_PER_MATCH) continue;
          const usedMarkets = matchMarkets.get(m.id) ?? new Set<MarketType>();
          const alternatives = (m.tips || [])
            .filter(
              (t) =>
                t.odds != null &&
                t.odds > 1.01 &&
                !usedMarkets.has(t.market) &&
                (tier === 'maluca'
                  ? t.odds >= 2.0
                  : t.odds >= MIN_LEG_ODD && t.odds <= MAX_LEG_ODD)
            )
            .sort((a, b) =>
              tier === 'maluca'
                ? (b.odds as number) - (a.odds as number)
                : b.prob - a.prob
            );
          const alt = alternatives[0];
          if (!alt || alt.odds == null) continue;
          repeats.push({
            ...m,
            tip: {
              market: alt.market,
              label: alt.label,
              odds: alt.odds,
              prob: alt.prob,
            },
          });
        }
        if (repeats.length > 0) {
          const mixed = [
            ...orderTopFirst(fresh, sortFn),
            ...orderTopFirst(repeats, sortFn),
          ];
          legs = pickUntilTarget(
            mixed,
            cfg,
            overrides?.diversifyLeagues !== false
          );
        }
      }

      if (!legs) {
        // Ultimo recurso dentro da faixa: tips FRESCAS de odd mais alta, sem
        // repetir jogos (evita correlacao entre fichas).
        const higherOdd = orderTopFirst(fresh, (a, b) => b.tip.odds - a.tip.odds);
        legs = pickUntilTarget(
          higherOdd,
          cfg,
          overrides?.diversifyLeagues !== false
        );
      }
      if (!legs) return null;
      const repeated = legs.filter((l) => (matchSlipCount.get(l.id) || 0) > 0).length;
      if (repeated > 0) {
        console.log(
          `[Fichas] ${tier}: ${legs.length} pernas (${repeated} jogo(s) repetido(s) com tip diferente).`
        );
      }

      const duplicate = candidateSlips.some(
        (s) =>
          s.legs.length === legs.length &&
          s.legs.every((l) =>
            legs.some((x) => x.id === l.id && x.tip.market === l.tip.market)
          )
      );
      if (duplicate) return null;

      const combinedOdds = legs.reduce((acc, l) => acc * l.tip.odds, 1);
      const avgOdds = Math.pow(combinedOdds, 1 / legs.length);
      const rationale =
        (tier === 'maluca'
          ? `Ficha Maluca: ${legs.length} tips de odd alta escolhidas entre as tips reais jÃ¡ calculadas, atÃ© ao alvo de ${cfg.targetOdds.toFixed(0)}x. Odd mÃ©dia por perna ${avgOdds.toFixed(2)}; nenhuma odd foi inventada para completar pontos.`
          : tier === 'ousada'
          ? `Ficha Ousada: ${legs.length} jogos escolhidos entre as tips reais por probabilidade, atÃ© ao alvo de ${cfg.targetOdds.toFixed(0)}x. Odd mÃ©dia por perna ${avgOdds.toFixed(2)}; os pontos vÃªm de acumular jogos, nÃ£o de pernas artificiais.`
          : `Ficha ${cfg.label}: ${legs.length} jogos escolhidos por probabilidade atÃ© ao alvo de ${cfg.targetOdds.toFixed(0)}x. Odd mÃ©dia por perna ${avgOdds.toFixed(2)}; todas as odds sÃ£o reais e nenhuma perna foi inventada para completar pontos.`)
        + (scope === 'longo'
          ? ` Longo prazo: ${legs.length} jogos (faixa ${LONGO_MIN_LEGS}-${LONGO_MAX_LEGS}).`
          : '');
      return this.createSlip(scope, tier, legs, {
        customTitle: `MÃºltipla ${cfg.label} (${legs.length} jogos â€¢ ${combinedOdds.toFixed(2)}x)`,
        rationale,
        engine: options?.engine ?? 'local',
      });
    };

    // Segura, Moderada e Ousada partem da MESMA pool de tips (probabilidade
    // mÃ©dia por jogo). O alvo de total manda: segura 3x, moderada 15x e
    // ousada 100x acendem-se com o nÃºmero de jogos necessÃ¡rio.
    for (const tier of ['segura', 'moderada'] as SlipTier[]) {
      const slip = buildTargetTier(tier);
      if (slip) {
        candidateSlips.push(slip);
        claim(slip.legs);
      }
    }

    // Tips alternativas de odd alta jÃ¡ calculadas pelo motor para cada jogo.
    // SÃ£o outro mercado real do mesmo jogo, nÃ£o uma odd inventada.
    const highRiskPool = selectionPool.map((m) =>
      m.highRiskTip ? { ...m, tip: m.highRiskTip } : m
    );

    // A Ousada usa as MESMAS tips de odd baixa da Segura/Moderada; a diferenca
    // e o alvo total (100x) alcancado com MUITOS jogos, nunca com pernas de
    // odd alta. So a Maluca usa as tips alternativas de odd alta.
    const ousada = buildTargetTier('ousada');
    if (ousada) {
      candidateSlips.push(ousada);
      claim(ousada.legs);
    }

    const malucaHigh = highRiskPool.filter((m) => m.tip.odds >= 2.0);
    const maluca = buildTargetTier('maluca', {
      pool: malucaHigh.length >= TICKET_TARGETS.maluca.minLegs ? malucaHigh : highRiskPool,
      sortFn: (a, b) => b.tip.odds - a.tip.odds,
    });
    if (maluca) {
      candidateSlips.push(maluca);
      claim(maluca.legs);
    }

    if (candidateSlips.length === 0) {
      console.warn(
        `[Fichas] ${scope}: nenhum tier atingiu o alvo com ${selectionPool.length} tip(s) elegivel(is).`
      );
    }

    // REGRA DE NEGÃ“CIO: reter bilhetes COERENTES (probabilidades prÃ³ximas,
    // ligas diversificadas), nÃ£o apenas os de maior pontuaÃ§Ã£o/odd.
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
    // depois as segundas variaÃ§Ãµes. Assim a quota de 4 rende uma ficha de
    // cada categoria em vez de duas seguras + uma moderada.
    const finalSlips: BetSlip[] = [];
    tierPriority.forEach((tier) => {
      if (byTier[tier][0]) finalSlips.push(byTier[tier][0]);
    });
    tierPriority.forEach((tier) => {
      for (let i = 1; i < byTier[tier].length; i++) finalSlips.push(byTier[tier][i]);
    });

    // Evita repetir pernas de fichas que jÃ¡ estÃ£o no estoque pendente do mesmo
    // horizonte. Se nÃ£o houver candidatos totalmente frescos, aceita os que nÃ£o
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
    // descartar tudo sÃ³ porque uma perna jÃ¡ existe noutra ficha pendente.
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
    // CalibraÃ§Ã£o/enriquecimento ficam no cache de jogos (sobrevive a redeploy).
    if (evaluatedMatches.length > 0) marketService.saveCacheSoon();
    if (topSlips.length > 0) {
      console.log(
        `[Fichas] ${scope}: ${topSlips.length} ficha(s) gerada(s) de ${selectionPool.length} tip(s) (${filtered.length} jogo(s) na janela).`
      );
    }

    return {
      generated: topSlips,
      all: this.slips,
      jevLatencyMs: localResponse.latencyMs,
      jevMeta,
    };
  }

  /**
   * Deixa o JEV escolher o mercado de cada jogo. O motor local continua a
   * calcular todas as probabilidades; o JEV recebe apenas as tips candidatas
   * (prob + odd real) e devolve o mercado escolhido. Picks persistidos na
   * calibraÃ§Ã£o sÃ£o reutilizados enquanto as odds nÃ£o mudarem.
   */
  /** Tips oferecidas ao JEV: top 6 por probabilidade, sÃ³ com odds reais. */
  private jevCandidateTips(
    match: MatchItem
  ): Array<{ market: MarketType; label: string; prob: number; odds: number }> {
    return (match.tips || [])
      // Para as fichas não-Maluca o JEV só escolhe entre tips de odd baixa;
      // a Maluca usa o highRiskTip local (odd alta, com alguma base).
      .filter(
        (t) =>
          t.odds != null &&
          t.odds >= MIN_LEG_ODD &&
          t.odds <= MAX_LEG_ODD
      )
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 6)
      .map((t) => ({
        market: t.market,
        label: t.label,
        prob: t.prob,
        odds: t.odds as number,
      }));
  }

  private async applyJevPicks(
    scope: SlipScope,
    evaluated: MatchItem[],
    horizonDays: number,
    persisted: Map<
      string,
      NonNullable<NonNullable<MatchItem['calibration']>['jevPick']>
    > = new Map()
  ): Promise<{ matches: MatchItem[]; meta: JevGenerationMeta }> {
    const emptyMeta: JevGenerationMeta = {
      reused: 0,
      newPicks: 0,
      apiCalls: 0,
      costUsd: 0,
      stale: 0,
    };
    const pool = evaluated.filter(
      (m) =>
        isMainLeague(m.league, m.competitionId) &&
        m.tip &&
        m.tip.odds > 1.01 &&
        (m.tips || []).some((t) => t.odds != null && t.odds > 1.01)
    );
    if (pool.length === 0) return { matches: [], meta: emptyMeta };

    type StoredPick = NonNullable<
      NonNullable<MatchItem['calibration']>['jevPick']
    >;
    const picks = new Map<string, StoredPick>();
    const need: MatchItem[] = [];
    let stale = 0;
    for (const m of pool) {
      const saved = persisted.get(m.id);
      // SÃ³ reutiliza se o mercado continuar entre as candidatas ATUAIS (top 6
      // com odds reais). SenÃ£o a decisÃ£o antiga pode escolher uma tip que jÃ¡
      // nÃ£o seria oferecida hoje (ex.: mercado que saiu do top 6).
      const offered = this.jevCandidateTips(m).some(
        (t) => t.market === saved?.market
      );
      if (saved && offered) {
        picks.set(m.id, saved);
      } else {
        if (saved) stale += 1;
        need.push(m);
      }
    }
    const reused = picks.size;
    let newPicks = 0;
    let apiCalls = 0;
    let costUsd = 0;

    if (need.length > 0) {
      const candidates = need
        .slice(0, 60)
        .map((m) => {
          // SÃ³ odds com proveniÃªncia real entram para o JEV (nada sintÃ©tico).
          const real = new Set(m.odds.realMarkets || []);
          const odds: Record<string, number> = {};
          if (real.has('home')) odds.home = m.odds.home;
          if (real.has('draw')) odds.draw = m.odds.draw;
          if (real.has('away')) odds.away = m.odds.away;
          if (real.has('over25')) odds.over25 = m.odds.over25;
          if (real.has('under25')) odds.under25 = m.odds.under25;
          if (real.has('btts_yes')) odds.btts_yes = m.odds.btts_yes;
          if (real.has('btts_no')) odds.btts_no = m.odds.btts_no;
          return {
            id: m.id,
            home: m.home,
            away: m.away,
            league: m.league,
            kickoff: new Date(m.kickoffAt).toISOString(),
            odds,
            tips: this.jevCandidateTips(m),
          };
        })
        .filter((c) => c.tips.length > 0);

      const chosen = await jevChooseMarkets(candidates);
      newPicks = chosen.picks.size;
      apiCalls = chosen.apiCalls;
      costUsd = chosen.costUsd;
      const at = Date.now();
      for (const [id, pick] of chosen.picks) {
        picks.set(id, {
          market: pick.market as MarketType,
          confidence: pick.confidence,
          reason: pick.reason,
          at,
        });
      }
      console.log(
        `[JEV] ${chosen.picks.size}/${candidates.length} decisÃ£o(Ãµes) nova(s) ` +
          `em ${chosen.apiCalls} chamada(s), custo ${chosen.costUsd.toFixed(6)} USD ` +
          `(escopo "${scope}"; ${reused} reutilizada(s), ${stale} antiga(s) descartada(s)).`
      );
    }

    if (picks.size === 0) {
      return { matches: [], meta: { reused, newPicks, apiCalls, costUsd, stale } };
    }

    const forced = pool.filter((m) => picks.has(m.id));
    const localInput: LocalDecisionInput = {
      scope,
      horizonDays,
      matches: forced.map((m) => ({
        id: m.id,
        league: m.league,
        home: m.home,
        away: m.away,
        daysFromNow: m.daysFromNow,
        odds: m.odds,
        context: m.context,
        scout: m.scout,
        advanced: m.advanced,
        tables: m.tables,
        lineups: m.lineups,
        forcedMarket: picks.get(m.id)!.market,
      })),
    };
    const resp = await callLocalInferenceEngine(localInput);
    const byId = new Map(resp.evaluations.map((e) => [e.matchId, e]));
    const out: MatchItem[] = [];
    for (const m of forced) {
      const ev = byId.get(m.id);
      const pick = picks.get(m.id);
      if (!ev || !pick || ev.selectedOdds <= 1.01) continue;
      m.tip = {
        market: ev.recommendedMarket,
        label: ev.marketLabel,
        odds: ev.selectedOdds,
        prob: ev.calibratedProb,
      };
      m.tips = ev.tips;
      m.highRiskTip = ev.highRiskTip;
      // A inferÃªncia exibida no cartÃ£o tem de ser a do mercado ESCOLHIDO pelo
      // JEV (antes ficava a do pick local anterior: prob/EV de outro mercado).
      m.jevInference = {
        calibratedProb: ev.calibratedProb,
        expectedValueEdge: ev.expectedValueEdge,
        recommendedMarket: ev.recommendedMarket,
        riskTier: ev.riskTier,
        latencyMs: resp.latencyMs,
        jevModelVersion: resp.modelVersion,
        jevConfidence: pick.confidence,
      };
      m.calibration = {
        tips: ev.tips,
        recommendedMarket: ev.recommendedMarket,
        marketLabel: ev.marketLabel,
        calibratedProb: ev.calibratedProb,
        expectedValueEdge: ev.expectedValueEdge,
        highRiskTip: ev.highRiskTip,
        oddsHash: oddsSignature(m.odds),
        at: Date.now(),
        jevPick: pick,
      };
      out.push(m);
    }
    return { matches: out, meta: { reused, newPicks, apiCalls, costUsd, stale } };
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
            tip: currentLeg.tip, // MantÃ©m o prognÃ³stico fixado no momento da aposta
            jevInference: currentLeg.jevInference,
          };
        }

        const leg = slip.legs[i];
        // O resultado da PERNA Ã© do mercado da prÃ³pria perna (pode ser
        // diferente do tip do match, ex.: Maluca/JEV). Sem isto, uma perna
        // "VitÃ³ria casa" podia ser marcada como acertada por o match ter
        // ganho noutro mercado.
        if (leg.result && leg.result.homeScore != null && leg.result.awayScore != null) {
          const outcome = marketOutcomeFor(
            leg.tip.market,
            leg.result.homeScore,
            leg.result.awayScore
          );
          if (leg.result.tipWon !== outcome.won || leg.result.pushed !== outcome.pushed) {
            leg.result = { ...leg.result, tipWon: outcome.won, pushed: outcome.pushed };
            dirty = true;
          }
        }
        if (leg.status !== 'resolved') {
          allResolved = false;
        } else if (leg.result && !leg.result.tipWon) {
          // Se qualquer perna errou o prognÃ³stico, o bilhete estÃ¡ matematicamente perdido
          anyLost = true;
        }
      }

      if (anyLost) {
        // Vai direto para o HistÃ³rico como PERDEU no momento em que a primeira perna falha
        slip.status = 'perdeu';
        slip.resolvedAt = now;
        dirty = true;
      } else if (allResolved) {
        // Se todas as pernas finalizaram e todas acertaram, GANHOU
        slip.status = 'ganhou';
        slip.resolvedAt = now;
        dirty = true;
      } else {
        // VENCEU/EXPIROU: passou o Ãºltimo pontapÃ© inicial + tolerÃ¢ncia e ainda nÃ£o
        // houve resoluÃ§Ã£o completa (jogo adiado/abandonado/sem placar real).
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

  /**
   * Recalcula tipWon/pushed de cada perna a partir do PLACAR e do mercado da
   * PRÃ“PRIA perna (nÃ£o do tip do match). Corrige fichas antigas que foram
   * resolvidas com o mercado do match e voltaram a "Acertou".
   */
  private repairLegResults(): void {
    const now = Date.now();
    let fixed = 0;
    for (const slip of this.slips) {
      let changed = false;
      let anyLost = false;
      let allResolved = true;

      for (const leg of slip.legs) {
        const res = leg.result;
        if (res && res.homeScore != null && res.awayScore != null) {
          const outcome = marketOutcomeFor(leg.tip.market, res.homeScore, res.awayScore);
          if (res.tipWon !== outcome.won || (res.pushed ?? false) !== outcome.pushed) {
            leg.result = { ...res, tipWon: outcome.won, pushed: outcome.pushed };
            changed = true;
          }
        }
        if (leg.status !== 'resolved') allResolved = false;
        else if (leg.result && !leg.result.tipWon) anyLost = true;
      }

      if (anyLost) {
        if (slip.status !== 'perdeu') {
          slip.status = 'perdeu';
          slip.resolvedAt = slip.resolvedAt ?? now;
          changed = true;
        }
      } else if (allResolved && slip.status !== 'expirado' && slip.status !== 'ganhou') {
        slip.status = 'ganhou';
        slip.resolvedAt = slip.resolvedAt ?? now;
        changed = true;
      }

      if (changed) {
        bilheteriaDb.upsertSlip(slip);
        fixed += 1;
      }
    }
    if (fixed > 0) {
      console.log(
        `[Bilheteria] ${fixed} ficha(s) corrigida(s): resultado recalculado por perna.`
      );
    }
  }

  public addCustomSlip(slip: BetSlip): BetSlip {
    if (!slip.dayKey) slip.dayKey = getDayKey(slip.createdAt || Date.now());
    this.slips.unshift(slip);
    bilheteriaDb.upsertSlip(slip);
    return slip;
  }

  /** Limpa todos os bilhetes (usado no reset â€” pernas antigas ficam Ã³rfÃ£s). */
  /**
   * Remove uma ficha da memÃ³ria e da base de dados (inclui o registo de
   * submissÃ£o Premier Bet associado). Devolve false se nÃ£o existir.
   */
  public deleteSlip(id: string): boolean {
    const index = this.slips.findIndex((slip) => slip.id === id);
    if (index === -1) return false;
    this.slips.splice(index, 1);
    bilheteriaDb.deleteSlips([id]);
    return true;
  }

  public clearSlips(): void {
    this.slips = [];
    bilheteriaDb.deleteAllSlips();
  }
}

export const ticketEngine = new TicketEngine();








