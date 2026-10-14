/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BetSlip, MatchItem, SlipScope, SlipTier } from './types.js';
import { marketService, leaguePriorityRank, isObscureLeague, isWomensLeague } from './marketService.js';
import { callLocalInferenceEngine, type LocalDecisionInput } from './aiscoreEngine.js';
import { aiscoreClient } from './aiscoreService.js';

/**
 * Peso por liga (jefe prioriza as principais):
 * Champions 1.30 > Europa 1.22 > EPL 1.18 > La Liga 1.15 >
 * Serie A/Bundesliga 1.10 > Ligue 1 1.08 > outras top 1.05 > resto 1.0
 */
const LEAGUE_WEIGHTS = [1.30, 1.22, 1.18, 1.15, 1.10, 1.10, 1.08, 1.05];

export function leagueWeight(league?: string | null): number {
  const rank = leaguePriorityRank(league);
  if (rank >= 99) return 1.0;
  return LEAGUE_WEIGHTS[Math.min(rank, LEAGUE_WEIGHTS.length - 1)] ?? 1.0;
}

export function isTopTierLeague(league?: string | null): boolean {
  return leaguePriorityRank(league) < 8;
}

// Metas de odd combinada por construção ousada.
const OUSADA_MIN_ODDS = 10;
const SUPER_OUSADA_MIN_ODDS = 1000;
const SUPER_OUSADA_MAX_LEGS = 12;

// Liga obscura (feminino/base/exótica) vale pouco na ordenação.
const OBSCURE_PENALTY = 0.55;

/** Score de ordenação: probabilidade calibrada × peso da liga (obscura penalizada). */
function pickScore(m: MatchItem): number {
  return m.tip.prob * leagueWeight(m.league) * (isObscureLeague(m.league) ? OBSCURE_PENALTY : 1);
}

/** Valor esperado aproximado: odd × probabilidade × peso da liga (obscura penalizada). */
function valueScore(m: MatchItem): number {
  return m.tip.odds * (m.tip.prob / 100) * leagueWeight(m.league) * (isObscureLeague(m.league) ? OBSCURE_PENALTY : 1);
}

/**
 * Ligas principais primeiro: ordena cada grupo pelo critério e concatena
 * top-tier antes do resto. Bilhetes saem com ligas grandes; as estranhas
 * só entram para completar quando faltam jogos principais.
 */
function orderTopFirst(arr: MatchItem[], sortFn: (a: MatchItem, b: MatchItem) => number): MatchItem[] {
  const top = arr.filter((m) => isTopTierLeague(m.league)).sort(sortFn);
  const rest = arr.filter((m) => !isTopTierLeague(m.league)).sort(sortFn);
  return [...top, ...rest];
}

/**
 * Garante quota mínima de ligas principais: se o pool tem jogo top-tier
 * mas as pernas selecionadas não, troca a última perna pela melhor top-tier.
 */
function ensureTopTierLegs(legs: MatchItem[], pool: MatchItem[]): MatchItem[] {
  if (legs.length === 0 || legs.some((l) => isTopTierLeague(l.league))) return legs;
  const candidates = pool
    .filter((m) => isTopTierLeague(m.league) && !legs.some((l) => l.id === m.id))
    .sort((a, b) => b.tip.prob * leagueWeight(b.league) - a.tip.prob * leagueWeight(a.league));
  if (candidates.length === 0) return legs;
  return [...legs.slice(0, -1), candidates[0]];
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

    const slip: BetSlip = {
      id: `${scopePrefix}-${tier.substring(0, 3).toUpperCase()}-${++this.slipCounter}`,
      scope,
      tier,
      color: tierConfig.color,
      legs: uniqueLegs,
      combinedOdds,
      combinedProb,
      expiresAt,
      status: 'pendente',
      createdAt: Date.now(),
      resolvedAt: null,
      customTitle: options?.customTitle,
      rationale: options?.rationale,
      isAiGenerated: options?.isAiGenerated ?? true, // Criado com base no motor local
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
    activeLeagues?: string[]
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

    // Femininos fora: nem entram no pool de avaliação/combinação.
    const eligible = filtered.filter((m) => !isWomensLeague(m.league));

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

    // Remove bilhetes pendentes anteriores deste mesmo escopo para substituí-los pelos recém-calculados
    this.slips = this.slips.filter((s) => !(s.scope === scope && s.status === 'pendente'));

    // Construtor Especializado para o Tier "Ousada" (mínimo de odd combinada)
    const buildOusadaSlip = (matchesPool: MatchItem[]): BetSlip | null => {
      if (matchesPool.length < 2) return null;

      // Melhor relação valor/probabilidade (peso de liga, obscura penalizada)
      const pool = orderTopFirst([...matchesPool], (a, b) => valueScore(b) - valueScore(a));

      const selectedLegs: MatchItem[] = [];
      let currentCombinedOdds = 1.0;

      for (const match of pool) {
        // Para o tier ousado, se o mercado for Dupla Chance muito baixa (< 1.40), busca uma tip mais audaciosa
        let legToAdd = match;
        if (match.tip.odds < 1.45 && (match.odds.home >= 1.70 || match.odds.away >= 1.70 || match.odds.btts_yes >= 1.70)) {
          // Seleciona mercado de maior valor (ex: Vitória Direta ou Ambas Marcam)
          let targetMarket = match.tip.market;
          let targetOdd = match.tip.odds;
          let targetProb = match.tip.prob;
          let targetLabel = match.tip.label;

          if (match.odds.btts_yes >= 1.70) {
            targetMarket = 'btts_yes';
            targetOdd = match.odds.btts_yes;
            targetProb = 52;
            targetLabel = 'Ambas marcam — Sim (BTTS)';
          } else if (match.odds.home >= 1.70 && match.odds.home <= 2.40) {
            targetMarket = 'home';
            targetOdd = match.odds.home;
            targetProb = 48;
            targetLabel = `Vitória ${match.home}`;
          } else if (match.odds.over25 && match.odds.over25 >= 1.75) {
            targetMarket = 'over25';
            targetOdd = match.odds.over25;
            targetProb = 50;
            targetLabel = 'Mais de 2.5 golos (+2.5G)';
          }

          legToAdd = {
            ...match,
            tip: {
              market: targetMarket,
              label: targetLabel,
              odds: Number(targetOdd.toFixed(2)),
              prob: targetProb,
            },
          };
        }

        selectedLegs.push(legToAdd);
        currentCombinedOdds *= legToAdd.tip.odds;

        // Atingiu o mínimo de odd combinada com pelo menos 3 pernas.
        if (currentCombinedOdds >= OUSADA_MIN_ODDS && selectedLegs.length >= 3) {
          break;
        }

        // Limite máximo de segurança de 7 pernas
        if (selectedLegs.length >= 7) {
          break;
        }
      }

      if (selectedLegs.length >= 2) {
        return this.createSlip(scope, 'ousada', ensureTopTierLegs(selectedLegs, pool), {
          customTitle: `Super Múltipla Ousada (${currentCombinedOdds.toFixed(2)}x)`,
          rationale: `Bilhete de alto retorno com odd combinada de ${currentCombinedOdds.toFixed(2)}, desenhado para maximizar o multiplicador com valor estatístico.`,
        });
      }

      return null;
    };

    /**
     * Perna ousada para a Super Ousada: é um bilhete de lotaria — maximiza
     * a odd (piso de 25% de prob., teto 4.50 para não alucinar em zebras).
     * Desempate pelo valor esperado. Devolve candidatos ordenados para o
     * acumulador diversificar mercados (máx. 3 repetições por mercado).
     */
    const boldLegRanked = (match: MatchItem): Array<{
      market: MatchItem['tip']['market']; label: string; odds: number; prob: number }> => {
      const cands: Array<{ market: MatchItem['tip']['market']; label: string; odds: number; prob: number }> = [
        { market: match.tip.market, label: match.tip.label, odds: match.tip.odds, prob: match.tip.prob },
      ];
      const o = match.odds;
      if (o.btts_yes >= 1.60) {
        cands.push({ market: 'btts_yes', label: 'Ambas marcam — Sim (BTTS)', odds: o.btts_yes, prob: 48 });
      }
      if ((o.over25 ?? 0) >= 1.70) {
        cands.push({ market: 'over25', label: 'Mais de 2.5 golos (+2.5G)', odds: o.over25 as number, prob: 46 });
      }
      if (o.home >= 1.70 && o.home <= 3.00) {
        cands.push({ market: 'home', label: `Vitória ${match.home}`, odds: o.home, prob: 44 });
      }
      if (o.away >= 1.70 && o.away <= 3.00) {
        cands.push({ market: 'away', label: `Vitória ${match.away}`, odds: o.away, prob: 42 });
      }
      if (o.draw >= 2.80 && o.draw <= 3.80) {
        cands.push({ market: 'draw', label: 'Empate (X)', odds: o.draw, prob: 27 });
      }
      const viable = cands.filter((c) => c.odds >= 1.60 && c.odds <= 4.50 && c.prob >= 25);
      return (viable.length > 0 ? viable : cands).sort(
        (a, b) => b.odds - a.odds || ((b.prob / 100) * b.odds - (a.prob / 100) * a.odds)
      );
    };

    const applyBold = (match: MatchItem, market: MatchItem['tip']['market'],
      label: string, odds: number, prob: number): MatchItem => {
      if (market === match.tip.market) return match;
      return {
        ...match,
        tip: { market, label, odds: Number(odds.toFixed(2)), prob },
      };
    };

    // SUPER OUSADA: acumulador até 1000x de odd combinada (até 12 pernas).
    // Só é criada se bater a meta — sem 1000x não há bilhete.
    const buildSuperOusadaSlip = (matchesPool: MatchItem[]): BetSlip | null => {
      if (matchesPool.length < 5) return null;
      const pool = orderTopFirst([...matchesPool], (a, b) => b.tip.odds - a.tip.odds);

      const selectedLegs: MatchItem[] = [];
      let currentCombinedOdds = 1.0;
      const marketCount: Record<string, number> = {};
      for (const match of pool) {
        const ranked = boldLegRanked(match);
        const pick = ranked.find((c) => (marketCount[c.market] || 0) < 3) || ranked[0];
        marketCount[pick.market] = (marketCount[pick.market] || 0) + 1;
        selectedLegs.push(applyBold(match, pick.market, pick.label, pick.odds, pick.prob));
        currentCombinedOdds *= selectedLegs[selectedLegs.length - 1].tip.odds;
        if (selectedLegs.length >= SUPER_OUSADA_MAX_LEGS) break;
        if (currentCombinedOdds >= SUPER_OUSADA_MIN_ODDS && selectedLegs.length >= 5) break;
      }

      if (currentCombinedOdds < SUPER_OUSADA_MIN_ODDS || selectedLegs.length < 5) {
        return null;
      }
      return this.createSlip(scope, 'ousada', selectedLegs, {
        customTitle: `Super Ousada (${currentCombinedOdds.toFixed(2)}x)`,
        rationale: `Acumulador extremo com odd combinada de ${currentCombinedOdds.toFixed(2)} em ${selectedLegs.length} pernas de ligas principais, para quem caça o prémio grande.`,
      });
    };

    const candidateSlips: BetSlip[] = [];
    const legsMap = LEGS_CONFIG[scope];

    // 1. Bilhetes Seguros (ligas principais primeiro, obscuras só p/ completar)
    const sortedSegura = orderTopFirst(
      [...(buckets.segura.length >= 2 ? buckets.segura : evaluatedMatches)],
      (a, b) => pickScore(b) - pickScore(a)
    );
    if (sortedSegura.length >= legsMap.segura) {
      candidateSlips.push(this.createSlip(scope, 'segura', ensureTopTierLegs(sortedSegura.slice(0, legsMap.segura), sortedSegura)));
      if (sortedSegura.length >= legsMap.segura * 2) {
        candidateSlips.push(this.createSlip(scope, 'segura', ensureTopTierLegs(sortedSegura.slice(legsMap.segura, legsMap.segura * 2), sortedSegura)));
      }
    }

    // 2. Bilhetes Moderados (ligas principais primeiro, obscuras só p/ completar)
    const sortedModerada = orderTopFirst(
      [...(buckets.moderada.length >= 2 ? buckets.moderada : evaluatedMatches)],
      (a, b) => valueScore(b) - valueScore(a)
    );
    if (sortedModerada.length >= legsMap.moderada) {
      candidateSlips.push(this.createSlip(scope, 'moderada', ensureTopTierLegs(sortedModerada.slice(0, legsMap.moderada), sortedModerada)));
      if (sortedModerada.length >= legsMap.moderada + 2) {
        candidateSlips.push(this.createSlip(scope, 'moderada', ensureTopTierLegs(sortedModerada.slice(1, legsMap.moderada + 1), sortedModerada)));
      }
    }

    // 3. Bilhetes Ousados (mínimo de odd combinada garantido)
    const ousadaSlip1 = buildOusadaSlip(evaluatedMatches);
    if (ousadaSlip1) {
      candidateSlips.push(ousadaSlip1);
    }

    // Segunda variação de Ousada com embaralhamento para ter 2 opções de alta odd
    if (evaluatedMatches.length >= 4) {
      const reversedPool = [...evaluatedMatches].reverse();
      const ousadaSlip2 = buildOusadaSlip(reversedPool);
      if (ousadaSlip2 && ousadaSlip2.combinedOdds !== ousadaSlip1?.combinedOdds) {
        candidateSlips.push(ousadaSlip2);
      }
    }

    // 4. SUPER OUSADA (1000x+): entra primeiro na lista de ousadas pelo odd.
    const superOusada = buildSuperOusadaSlip(evaluatedMatches);
    if (superOusada) {
      candidateSlips.push(superOusada);
    }

    // REGRA DE NEGÓCIO: Reter os melhores bilhetes com variedade entre os tiers (até 5 bilhetes no total)
    const finalSlips: BetSlip[] = [];
    const seguraList = candidateSlips.filter((s) => s.tier === 'segura').sort((a, b) => b.combinedProb - a.combinedProb);
    const moderadaList = candidateSlips.filter((s) => s.tier === 'moderada').sort((a, b) => b.combinedProb - a.combinedProb);
    const ousadaList = candidateSlips.filter((s) => s.tier === 'ousada').sort((a, b) => b.combinedOdds - a.combinedOdds);

    if (seguraList[0]) finalSlips.push(seguraList[0]);
    if (seguraList[1]) finalSlips.push(seguraList[1]);
    if (moderadaList[0]) finalSlips.push(moderadaList[0]);
    if (moderadaList[1]) finalSlips.push(moderadaList[1]);
    if (ousadaList[0]) finalSlips.push(ousadaList[0]);
    if (ousadaList[1] && finalSlips.length < 5) finalSlips.push(ousadaList[1]);

    const topSlips = finalSlips.slice(0, 5);

    for (const slip of topSlips) {
      this.slips.push(slip);
    }

    return {
      generated: topSlips,
      all: this.slips,
      jevLatencyMs: localResponse.latencyMs,
    };
  }

  public validateSlips(): { updatedSlips: BetSlip[] } {
    const updated: BetSlip[] = [];
    const now = Date.now();

    for (const slip of this.slips) {
      if (slip.status !== 'pendente') continue;

      let anyLost = false;
      let allResolved = true;

      for (let i = 0; i < slip.legs.length; i++) {
        const currentLeg = slip.legs[i];
        // Sincroniza em tempo real com o estado mais recente da partida no marketService
        const freshMatch = marketService.getMatchById(currentLeg.id);
        if (freshMatch) {
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
        updated.push(slip);
      } else if (allResolved) {
        // Se todas as pernas finalizaram e todas acertaram, GANHOU
        slip.status = 'ganhou';
        slip.resolvedAt = now;
        updated.push(slip);
      }
    }

    return { updatedSlips: updated };
  }

  public addCustomSlip(slip: BetSlip): BetSlip {
    this.slips.unshift(slip);
    return slip;
  }

  /** Limpa todos os bilhetes (usado no reset — pernas antigas ficam órfãs). */
  public clearSlips(): void {
    this.slips = [];
  }
}

export const ticketEngine = new TicketEngine();
