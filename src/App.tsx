/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  MatchItem,
  MatchTip,
  BetSlip,
  BackendStatus,
  AiMatchAnalysis,
  SlipScope,
  SlipTier,
  HistoryFilter,
  TicketStockStatus,
  PremierBetUploadResult,
  TipMarket,
  CartLeg,
  JevStatus,
  Progression,
} from './types.js';
import * as api from './api.js';
import { Header } from './components/Header.tsx';
import { HeroStats } from './components/HeroStats.tsx';
import { FixturesSidebar } from './components/FixturesSidebar.tsx';
import { TicketCard } from './components/TicketCard.tsx';
import { HistoryList } from './components/HistoryList.tsx';
import { UploadSlipModal } from './components/UploadSlipModal.tsx';
import { ApiConfigModal } from './components/ApiConfigModal.tsx';
import { AiAnalysisModal } from './components/AiAnalysisModal.tsx';
import { AiSmartSlipModal } from './components/AiSmartSlipModal.tsx';
import { CustomSlipDrawer } from './components/CustomSlipDrawer.tsx';
import { EngineTabs, EngineTab } from './components/EngineTabs.tsx';
import { ManualTab } from './components/ManualTab.tsx';
import { JevTab } from './components/JevTab.tsx';
import { AutomationTab } from './components/AutomationTab.tsx';
import { Zap, CheckCircle2, RotateCcw, Cpu, Loader2, ShoppingCart } from 'lucide-react';
import { getSavedTimezone, saveTimezone, getDayKeyInTz } from './utils/timezone.js';
import { leagueRank } from './utils/leagues.js';
import {
  byMostRecent,
  engineOf,
  isSlipToday,
  matchInScope,
  ScopeOption,
  scopeLabel,
} from './utils/slips.js';

const DAY_TIMEZONE = 'Africa/Luanda';

export default function App() {
  const [matches, setMatches] = useState<MatchItem[]>([]);
  const [slips, setSlips] = useState<BetSlip[]>([]);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [stock, setStock] = useState<TicketStockStatus | null>(null);
  const [activeLeagues, setActiveLeagues] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<SlipScope>('dia');
  const [tier, setTier] = useState<SlipTier>('segura');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('andamento');
  const [lastGeneratedTime, setLastGeneratedTime] = useState<string>('');
  const [timezone, setTimezone] = useState<string>(() => getSavedTimezone());
  const [activeEngine, setActiveEngine] = useState<EngineTab>('principal');
  const [progressions, setProgressions] = useState<Progression[]>([]);

  const [jevStatus, setJevStatus] = useState<JevStatus | null>(null);
  const [jevStatusLoading, setJevStatusLoading] = useState(false);
  const [jevStatusError, setJevStatusError] = useState(false);
  const [generatingJev, setGeneratingJev] = useState(false);

  // Modals & loading states
  const [isApiModalOpen, setIsApiModalOpen] = useState(false);
  const [isAiSlipModalOpen, setIsAiSlipModalOpen] = useState(false);
  const [isAiAnalysisModalOpen, setIsAiAnalysisModalOpen] = useState(false);
  const [selectedMatchForAi, setSelectedMatchForAi] = useState<MatchItem | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiMatchAnalysis | null>(null);
  const [uploadSlip, setUploadSlip] = useState<BetSlip | null>(null);

  // GeraÃ§Ã£o automÃ¡tica por tipo de tip + carrinho da ficha manual
  const [tipMarkets, setTipMarkets] = useState<TipMarket[]>([]);
  const [selectedMarket, setSelectedMarket] = useState('');
  const [cart, setCart] = useState<CartLeg[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [creatingCustom, setCreatingCustom] = useState(false);

  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [analyzingAi, setAnalyzingAi] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Initial load
  const loadInitialData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setLoading(true);
      const [statusData, matchesData, slipsData, stockData, progressionsData] = await Promise.all([
        api.fetchBackendStatus(),
        api.fetchMatches(isRefresh),
        api.fetchTickets(),
        api.fetchTicketStock(),
        api.fetchProgressions().catch(() => [] as Progression[]),
      ]);

      setBackendStatus(statusData);
      setMatches(matchesData);
      setSlips(slipsData);
      setStock(stockData);
      setProgressions(progressionsData);

      // Initialize all leagues as active and ensure new leagues are included
      setActiveLeagues((prev) => {
        if (prev.size === 0) {
          return new Set(matchesData.map((m) => m.league));
        }
        const next = new Set(prev);
        matchesData.forEach((m) => next.add(m.league));
        return next;
      });

      setLastGeneratedTime(
        (prev) =>
          prev || new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      );
    } catch (err: any) {
      console.error('Erro ao sincronizar com backend:', err);
    } finally {
      if (isRefresh) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  const loadJevStatus = useCallback(async () => {
    setJevStatusLoading(true);
    setJevStatusError(false);
    try {
      setJevStatus(await api.fetchJevStatus());
    } catch {
      setJevStatusError(true);
    } finally {
      setJevStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJevStatus();
  }, [loadJevStatus]);

  const refreshProgressions = useCallback(async () => {
    try {
      const [progressionsData, slipsData] = await Promise.all([
        api.fetchProgressions(),
        api.fetchTickets(),
      ]);
      setProgressions(progressionsData);
      setSlips(slipsData);
    } catch {
      /* silencioso */
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void refreshProgressions();
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshProgressions]);

  // Tipos de tip disponÃ­veis para a geraÃ§Ã£o automÃ¡tica.
  useEffect(() => {
    api
      .fetchTipMarkets()
      .then(setTipMarkets)
      .catch(() => {
        /* o seletor fica sÃ³ com a opÃ§Ã£o automÃ¡tica */
      });
  }, []);

  // Polling de bilhetes mais espaÃ§ado (evita re-renders e pedidos em rajada).
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        setSlips(await api.fetchTickets());
      } catch {
        // Silently catch background polling errors
      }
    }, 20000);

    return () => clearInterval(interval);
  }, []);

  // Os jogos sÃ³ sÃ£o atualizados na aba Manual (e no refresh explÃ­cito).
  useEffect(() => {
    if (activeEngine !== 'manual') return;
    const interval = setInterval(async () => {
      try {
        setMatches(await api.fetchMatches());
      } catch {
        /* silencioso */
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [activeEngine]);

  // Stock/quota refresh (pouco frequente â€” geraÃ§Ã£o Ã© pesada, leitura Ã© leve)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        setStock(await api.fetchTicketStock());
      } catch {
        /* silencioso */
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // League toggle
  const handleToggleLeague = (league: string) => {
    setActiveLeagues((prev) => {
      const next = new Set(prev);
      if (next.has(league)) {
        if (next.size > 1) next.delete(league);
      } else {
        next.add(league);
      }
      return next;
    });
  };

  // Generate for Specific Scope
  const handleGenerateScope = async (targetScope: 'dia' | '2_3_dias' | 'longo') => {
    try {
      setGenerating(true);
      const result = await api.generateTickets(
        targetScope,
        Array.from(activeLeagues),
        2
      );
      setSlips(result.all);
      if (result.stock) setStock(result.stock);
      setScope(targetScope);
      setTier('segura');
      setLastGeneratedTime(
        new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      );

      const labelMap = {
        dia: 'Hoje',
        '2_3_dias': '2 a 3 Dias',
        longo: 'Longo Prazo',
      };
      if (result.generated.length > 0) {
        showToast(
          `${result.generated.length} nova(s) ficha(s) de ${labelMap[targetScope]} geradas e guardadas.`
        );
      } else {
        showToast(result.message || `Sem fichas novas para ${labelMap[targetScope]} neste momento.`);
      }
    } catch (err: any) {
      showToast(err?.message || 'Erro ao gerar bilhetes');
    } finally {
      setGenerating(false);
    }
  };

  // ---------------------------------------- geraÃ§Ã£o manual por tipo de tip ---
  const handleGenerateManualByMarket = async (targetScope: ScopeOption, market: string) => {
    try {
      setGenerating(true);
      const result = await api.generateTickets(
        targetScope,
        Array.from(activeLeagues),
        2,
        market || undefined,
        'manual'
      );
      setSlips(result.all);
      if (result.stock) setStock(result.stock);
      setLastGeneratedTime(
        new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      );

      if (result.generated.length > 0) {
        showToast(
          `${result.generated.length} nova(s) ficha(s) manual(is) de ${scopeLabel(
            targetScope
          )} geradas e guardadas.`
        );
      } else {
        showToast(
          result.message ||
            `Sem fichas novas para ${scopeLabel(targetScope)} neste momento.`
        );
      }
    } catch (err: any) {
      showToast(err?.message || 'Erro ao gerar ficha manual');
    } finally {
      setGenerating(false);
    }
  };

  // ------------------------------------------------------------- geraÃ§Ã£o JEV ---
  const handleGenerateJev = async (targetScope: ScopeOption, limit: number) => {
    try {
      setGeneratingJev(true);
      const result = await api.generateJevTickets(targetScope, limit);
      setSlips(result.all);
      if (result.stock) setStock(result.stock);
      setLastGeneratedTime(
        new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      );

      if (result.generated.length > 0) {
        showToast(
          `${result.generated.length} nova(s) ficha(s) JEV de ${scopeLabel(
            targetScope
          )} geradas e guardadas.`
        );
      } else {
        showToast(
          result.message || `Sem fichas novas do JEV para ${scopeLabel(targetScope)} neste momento.`
        );
      }
    } catch (err: any) {
      showToast(err?.message || 'Erro ao gerar fichas com o JEV');
    } finally {
      setGeneratingJev(false);
    }
  };

  // -------------------------------------------------- ficha manual / carrinho ---
  const isInCart = (matchId: string, market: string) =>
    cart.some((leg) => leg.matchId === matchId && leg.market === market);

  const handleAddToCart = (match: MatchItem, tip: MatchTip) => {
    const odds = tip.odds;
    if (odds == null) return;

    if (isInCart(match.id, tip.market)) return;

    setCart((prev) => [
      ...prev,
      {
        matchId: match.id,
        market: tip.market,
        label: tip.label,
        odds,
        prob: tip.prob,
        home: match.home,
        away: match.away,
        league: match.league,
      },
    ]);
  };

  const handleRemoveFromCart = (matchId: string, market: string) => {
    setCart((prev) => prev.filter((leg) => !(leg.matchId === matchId && leg.market === market)));
  };

  const handleCreateCustomSlip = async (
    targetScope: 'dia' | '2_3_dias' | 'longo',
    targetTier?: SlipTier
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      setCreatingCustom(true);
      const result = await api.createCustomSlip(
        targetScope,
        cart.map((leg) => ({ matchId: leg.matchId, market: leg.market })),
        targetTier
      );

      setSlips(result.all);
      setScope(targetScope);
      setTier(result.slip.tier);
      setActiveEngine('manual');
      setLastGeneratedTime(
        new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      );
      setCart([]);
      setIsCartOpen(false);

      const scopeLabel =
        targetScope === 'dia' ? 'Hoje' : targetScope === '2_3_dias' ? '2 a 3 Dias' : 'Longo Prazo';
      showToast(
        `Ficha manual de ${scopeLabel} criada com ${result.slip.legs.length} jogo(s).`
      );
      return { ok: true };
    } catch (err: any) {
      const message = err?.message || 'Erro ao criar a ficha manual';
      showToast(message);
      return { ok: false, error: message };
    } finally {
      setCreatingCustom(false);
    }
  };

  // Sincroniza o estado da ficha depois de uma tentativa de submissÃ£o Ã  Premier Bet.
  const handleSlipUploaded = async (result: PremierBetUploadResult | null) => {
    try {
      const refreshed = await api.fetchTickets();
      setSlips(refreshed);
      setUploadSlip((current) =>
        current ? refreshed.find((item) => item.id === current.id) ?? current : current
      );
    } catch {
      /* o polling de 4s volta a sincronizar */
    }
    if (result?.ok) {
      showToast(
        result.dryRun
          ? 'Boletim de teste preenchido na Premier Bet (sem aposta).'
          : 'Ficha colocada na Premier Bet.'
      );
    }
  };

  // Exclui a ficha da memÃ³ria e da base de dados (sem resquÃ­cios).
  const handleDeleteSlip = async (slip: BetSlip) => {
    const aviso =
      slip.upload?.status === 'placed'
        ? `A ficha ${slip.id} jÃ¡ foi colocada na Premier Bet. Excluir remove o registo local e o histÃ³rico de submissÃ£o (a aposta na Premier Bet NÃƒO Ã© cancelada). Continuar?`
        : `Excluir a ficha ${slip.id}? Esta aÃ§Ã£o remove a ficha da memÃ³ria e da base de dados.`;
    if (!window.confirm(aviso)) return;
    try {
      const result = await api.deleteTicket(slip.id);
      setSlips(result.all);
      if (result.stock) setStock(result.stock);
      setUploadSlip((current) => (current?.id === slip.id ? null : current));
      showToast(`Ficha ${slip.id} excluÃ­da.`);
    } catch (err: any) {
      showToast(err?.message || 'Falha ao excluir a ficha.');
    }
  };

  // Simulate Next Match Resolution
  const handleSimulateNext = async () => {
    try {
      setIsSimulating(true);
      const { resolved, allSlips } = await api.resolveMatch(undefined, true);
      setSlips(allSlips);
      const updatedMatches = await api.fetchMatches();
      setMatches(updatedMatches);

      if (resolved.length > 0) {
        const m = resolved[0];
        const statusStr = m.result?.tipWon ? 'Venceu âœ“' : 'Falhou âœ•';
        showToast(`${m.home} ${m.result?.homeScore}-${m.result?.awayScore} ${m.away} (${statusStr})`);
      } else {
        showToast('Todas as partidas desta lista jÃ¡ foram resolvidas.');
      }
    } catch (err: any) {
      showToast(err?.message || 'Erro ao simular');
    } finally {
      setIsSimulating(false);
    }
  };

  // Reset matches & slips
  const handleResetMatches = async () => {
    try {
      setLoading(true);
      const { matches: newMatches, slips: newSlips } = await api.resetMatches();
      setMatches(newMatches);
      setSlips(newSlips);
      try {
        setStock(await api.fetchTicketStock());
      } catch {
        /* ignore */
      }
      showToast('Partidas e bilhetes reiniciados.');
    } catch (err: any) {
      showToast('Erro ao reiniciar');
    } finally {
      setLoading(false);
    }
  };

  // Analyze Match with AI
  const handleAnalyzeMatch = async (match: MatchItem) => {
    setSelectedMatchForAi(match);
    setIsAiAnalysisModalOpen(true);
    setAnalyzingAi(true);
    setAiAnalysis(null);

    try {
      const data = await api.analyzeMatchWithAi(match.id);
      setAiAnalysis(data);
    } catch (err: any) {
      console.warn('Erro ao analisar com IA:', err);
    } finally {
      setAnalyzingAi(false);
    }
  };

  // Generate Smart Slip with AI
  const handleGenerateAiSlip = async (preference: string) => {
    try {
      setGenerating(true);
      const result = await api.generateSmartSlipWithAi(preference);
      setSlips(result.allSlips);
      setScope('dia');
      setTier(result.slip.tier);
      showToast(`Bilhete Inteligente "${result.slip.customTitle}" criado!`);
    } catch (err: any) {
      showToast(err?.message || 'Erro ao gerar bilhete com IA');
    } finally {
      setGenerating(false);
    }
  };

  // Rank por ID oficial quando existir (evita "Premier League" do Catar
  // ser confundida com a inglesa); senÃ£o, cai no nome.
  const leagueRankById = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of matches) {
      const rank = leagueRank(m.league, m.competitionId);
      const prev = map.get(m.league);
      if (prev === undefined || rank < prev) map.set(m.league, rank);
    }
    return map;
  }, [matches]);

  const rankOf = useCallback(
    (league: string) => leagueRankById.get(league) ?? leagueRank(league),
    [leagueRankById]
  );

  const allLeaguesList = useMemo(
    () =>
      Array.from(new Set(matches.map((m) => m.league))).sort(
        (a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b)
      ),
    [matches, rankOf]
  );

  // Ligas principais primeiro, depois cronolÃ³gico.
  const filteredMatches = useMemo(
    () =>
      matches
        .filter((m) => activeLeagues.has(m.league))
        .sort((a, b) => rankOf(a.league) - rankOf(b.league) || a.kickoffAt - b.kickoffAt),
    [matches, activeLeagues, rankOf]
  );

  const poolMatches = useMemo(() => {
    if (scope === 'historico') return filteredMatches;
    return filteredMatches.filter((m) => matchInScope(m, scope));
  }, [filteredMatches, scope]);

  // Toggle "SÃ³ principais": filtra para Champions/Europa/EPL/La Liga/Serie A/Bundesliga/Ligue 1+
  const topTierLeagues = useMemo(
    () => allLeaguesList.filter((l) => rankOf(l) < 8),
    [allLeaguesList, rankOf]
  );

  const onlyTopActive = useMemo(
    () =>
      topTierLeagues.length > 0 &&
      topTierLeagues.every((l) => activeLeagues.has(l)) &&
      Array.from(activeLeagues).every((l) => rankOf(l) < 8),
    [topTierLeagues, activeLeagues, rankOf]
  );

  const handleOnlyTopLeagues = () => {
    if (onlyTopActive) {
      setActiveLeagues(new Set(allLeaguesList));
    } else if (topTierLeagues.length > 0) {
      setActiveLeagues(new Set(topTierLeagues));
    } else {
      showToast('Sem jogos das ligas principais no horizonte atual');
    }
  };

  // ---------------------------------------------------------------- fichas ---
  // "Hoje" mostra apenas as fichas pendentes criadas no dia-calendÃ¡rio de
  // Angola. As mais antigas continuam a persistir e aparecem no histÃ³rico
  // (Em andamento) atÃ© serem resolvidas ou expirarem.
  const principalSlips = useMemo(() => slips.filter((s) => engineOf(s) === 'local'), [slips]);
  const manualSlips = useMemo(() => slips.filter((s) => engineOf(s) === 'manual'), [slips]);
  const jevSlips = useMemo(() => slips.filter((s) => engineOf(s) === 'jev'), [slips]);

  const engineCounts = useMemo<Record<EngineTab, number>>(() => {
    const counts: Record<EngineTab, number> = {
      principal: 0,
      manual: 0,
      jev: 0,
      automacao: 0,
    };
    for (const slip of slips) {
      if (slip.status !== 'pendente') continue;
      const engine = engineOf(slip);
      if (engine === 'manual') counts.manual += 1;
      else if (engine === 'jev') counts.jev += 1;
      else if (engine === 'progression') continue;
      else counts.principal += 1;
    }
    counts.automacao = progressions.filter((p) => p.status === 'ativa').length;
    return counts;
  }, [slips, progressions]);

  const todayKey = getDayKeyInTz(Date.now(), DAY_TIMEZONE);

  const slipsInScope = useMemo(
    () =>
      principalSlips.filter(
        (s) =>
          s.scope === scope &&
          s.status === 'pendente' &&
          (scope !== 'dia' || isSlipToday(s, todayKey, DAY_TIMEZONE))
      ),
    [principalSlips, scope, todayKey]
  );

  const tierCounts = useMemo<Record<SlipTier, number>>(() => {
    const counts: Record<SlipTier, number> = {
      segura: 0,
      moderada: 0,
      ousada: 0,
      maluca: 0,
    };
    for (const slip of slipsInScope) counts[slip.tier] += 1;
    return counts;
  }, [slipsInScope]);

  const displayedSlips = useMemo(
    () =>
      slipsInScope
        .filter((s) => s.tier === tier)
        .sort((a, b) => b.createdAt - a.createdAt),
    [slipsInScope, tier]
  );

  const historyBuckets = useMemo<Record<HistoryFilter, BetSlip[]>>(() => {
    const next: Record<HistoryFilter, BetSlip[]> = {
      andamento: [],
      ganhas: [],
      perdidas: [],
      vencidas: [],
    };
    for (const slip of principalSlips) {
      if (slip.status === 'pendente') next.andamento.push(slip);
      else if (slip.status === 'ganhou') next.ganhas.push(slip);
      else if (slip.status === 'perdeu') next.perdidas.push(slip);
      else next.vencidas.push(slip);
    }
    next.andamento.sort(byMostRecent);
    next.ganhas.sort(byMostRecent);
    next.perdidas.sort(byMostRecent);
    next.vencidas.sort(byMostRecent);
    return next;
  }, [principalSlips]);

  const historySlips = historyBuckets[historyFilter];
  const historyTotal = useMemo(
    () => principalSlips.filter((s) => s.status !== 'pendente').length,
    [principalSlips]
  );

  const historyFilterLabel: Record<HistoryFilter, string> = {
    andamento: 'Em andamento',
    ganhas: 'Ganhas',
    perdidas: 'Perdidas',
    vencidas: 'Vencidas',
  };

  const historyEmpty: Record<HistoryFilter, { title: string; hint: string }> = {
    andamento: {
      title: 'Nenhuma ficha em andamento.',
      hint: 'As fichas pendentes (incluindo as de dias anteriores ainda nÃ£o resolvidas) aparecem aqui.',
    },
    ganhas: {
      title: 'Ainda nÃ£o hÃ¡ fichas ganhas.',
      hint: 'Quando todas as pernas de uma ficha acertarem, ela passa para esta aba.',
    },
    perdidas: {
      title: 'Ainda nÃ£o hÃ¡ fichas perdidas.',
      hint: 'Uma ficha cai para aqui no momento em que a primeira perna falha.',
    },
    vencidas: {
      title: 'Ainda nÃ£o hÃ¡ fichas vencidas.',
      hint: 'Fichas sem resoluÃ§Ã£o depois do prazo (Ãºltimo jogo + tolerÃ¢ncia) sÃ£o movidas para aqui.',
    },
  };

  // Dia(s) considerados no escopo atual (Angola), visível na UI.
  const scopeDayLabel = useMemo(() => {
    const fmt = (offset: number) =>
      new Intl.DateTimeFormat('pt-PT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: timezone,
      }).format(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
    if (scope === 'dia') return `Jogos de ${fmt(0)} (hoje em ${timezone})`;
    if (scope === '2_3_dias') return `Jogos de ${fmt(0)} a ${fmt(3)}`;
    if (scope === 'longo') return `Jogos de ${fmt(0)} a ${fmt(8)}`;
    return 'Histórico de fichas';
  }, [scope, timezone]);

  // Tier note text matching longevity scope
  const tierNoteText = () => {
    const spread =
      scope === 'dia'
        ? 'jogos de hoje'
        : scope === '2_3_dias'
        ? 'jogos de hoje atÃ© +3 dias'
        : 'os melhores jogos de hoje atÃ© +8 dias (seleÃ§Ã£o rigorosa, 10 a 22 jogos)';

    if (tier === 'segura') {
      return `Fichas de ${spread} escolhidas entre as tips de maior probabilidade, atÃ© ao alvo de 3x. O nÃºmero de jogos Ã© o necessÃ¡rio para chegar ao alvo â€” sem odds inventadas.`;
    }

    if (tier === 'moderada') {
      return `Fichas de ${spread} com alvo de 15x: o motor pega nas tips de risco moderado e acrescenta jogos atÃ© completar os pontos, sem pernas de odd artificial.`;
    }

    if (tier === 'ousada') {
      return `Fichas de ${spread} com alvo de 100x: mais jogos e odds individuais do tier ousado, sem empilhar pernas inventadas para chegar aos pontos.`;
    }

    return `Ficha Maluca: 4 a 8 ${spread}, com odds individuais 1.75x-3.0x, probabilidade mínima 25% e alvo 250x. As tips são escolhidas por probabilidade/forma, sem odds extremas 6x/8x.`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#081C13] text-[#F5F3EC]">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-24 right-6 z-50 bg-[#0E2A1C] border border-[#E7B33E]/50 text-[#F5F3EC] px-4 py-3 rounded-lg shadow-2xl flex items-center gap-2.5 text-xs font-medium animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-[#4FAE73] shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <Header
        status={backendStatus}
        onOpenApiModal={() => setIsApiModalOpen(true)}
        onOpenAiSlipModal={() => setIsAiSlipModalOpen(true)}
        onRefresh={() => loadInitialData(true)}
        onGenerate={() => handleGenerateScope(scope === 'historico' ? 'dia' : (scope as 'dia' | '2_3_dias' | 'longo'))}
        generating={generating}
        loading={loading}
        timezone={timezone}
        onTimezoneChange={(tz) => {
          setTimezone(tz);
          saveTimezone(tz);
          showToast(`Fuso horÃ¡rio atualizado para ${tz}`);
        }}
      />

      <EngineTabs
        active={activeEngine}
        onChange={setActiveEngine}
        counts={engineCounts}
      />

      {activeEngine === 'principal' && (
        <>
          {/* Hero & Aggregate Stats with Jev & 3-horizon buttons */}
          <HeroStats
            matches={matches}
            slips={principalSlips}
            stock={stock}
            backendStatus={backendStatus}
            lastGeneratedTime={lastGeneratedTime}
            activeScope={scope}
            onGenerateScope={handleGenerateScope}
            onOpenAiSlipModal={() => setIsAiSlipModalOpen(true)}
            generating={generating}
          />

          {/* Main Layout */}
          <main className="flex-1 max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-9">
            <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-8 items-start">
          {/* Left Sidebar: Fixtures */}
          <FixturesSidebar
            matches={poolMatches}
            allLeagues={allLeaguesList}
            activeLeagues={activeLeagues}
            onToggleLeague={handleToggleLeague}
            onlyTopActive={onlyTopActive}
            onOnlyTopLeagues={handleOnlyTopLeagues}
            scope={scope}
            onAnalyzeMatch={handleAnalyzeMatch}
            onSimulateNext={handleSimulateNext}
            isSimulating={isSimulating}
            timezone={timezone}
            onAddToCart={handleAddToCart}
            isInCart={isInCart}
            cartCount={cart.length}
            onOpenCart={() => setIsCartOpen(true)}
          />

          {/* Right Section: Slips Grid */}
          <section className="min-w-0">
            {/* Title */}
            <div className="flex items-baseline justify-between mb-3.5">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-2xl font-semibold tracking-wide text-[#F5F3EC]">
                  Bilhetes
                </h2>
                <span className="text-xs px-2 py-0.5 rounded bg-[#173C27] text-[#4FAE73] border border-[#4FAE73]/30 font-medium flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-[#E7B33E]" /> Jev Probabilities
                </span>
              </div>
              {scope === 'historico' && (
                <button
                  type="button"
                  onClick={handleResetMatches}
                  className="cursor-pointer text-xs text-[rgba(245,243,236,0.5)] hover:text-[#E7B33E] flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reiniciar ciclo</span>
                </button>
              )}
            </div>

            {/* Scope Tabs: Hoje | 2 a 3 Dias | Longo Prazo | HistÃ³rico */}
            <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Ver bilhetes">
              <button
                type="button"
                onClick={() => setScope('dia')}
                className={`cursor-pointer text-xs px-3.5 py-1.5 rounded-full border transition-all ${
                  scope === 'dia'
                    ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold shadow-sm'
                    : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                }`}
              >
                Hoje
              </button>
              <button
                type="button"
                onClick={() => setScope('2_3_dias')}
                className={`cursor-pointer text-xs px-3.5 py-1.5 rounded-full border transition-all ${
                  scope === '2_3_dias'
                    ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold shadow-sm'
                    : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                }`}
              >
                2 a 3 dias
              </button>
              <button
                type="button"
                onClick={() => setScope('longo')}
                className={`cursor-pointer text-xs px-3.5 py-1.5 rounded-full border transition-all ${
                  scope === 'longo'
                    ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold shadow-sm'
                    : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                }`}
              >
                Longo prazo (10-22 jogos)
              </button>
              <button
                type="button"
                onClick={() => setScope('historico')}
                className={`cursor-pointer text-xs px-3.5 py-1.5 rounded-full border transition-all ${
                  scope === 'historico'
                    ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold shadow-sm'
                    : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                }`}
              >
                HistÃ³rico ({historyTotal})
              </button>
            </div>

            <p className="text-[11px] text-[rgba(245,243,236,0.5)] -mt-2 mb-4">
              {scopeDayLabel}
            </p>

            {/* HistÃ³rico: sub-abas por estado */}
            {scope === 'historico' && (
              <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Filtrar histÃ³rico">
                {(['andamento', 'ganhas', 'perdidas', 'vencidas'] as HistoryFilter[]).map((f) => {
                  const active = historyFilter === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setHistoryFilter(f)}
                      className={`cursor-pointer text-xs px-3 py-1.5 rounded border transition-all ${
                        active
                          ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold'
                          : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                      }`}
                    >
                      {historyFilterLabel[f]}
                      <span className="ml-1.5 opacity-70">({historyBuckets[f].length})</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Validation Ticker Note */}
            <p className="text-xs text-[rgba(245,243,236,0.5)] mb-5 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#4FAE73] animate-pulse-subtle shrink-0" />
              <span>
                Agendador ativo no backend (fuso de Angola) â€” todos os dias Ã  00:00 cria as fichas
                do dia e repÃµe o estoque. Cada ficha passa a{' '}
                <strong className="text-[#4FAE73] font-semibold">ganha</strong>,{' '}
                <strong className="text-[#D1594B] font-semibold">perdida</strong> ou{' '}
                <strong className="text-[#E7B33E] font-semibold">vencida</strong> automaticamente.
              </span>
            </p>

            {/* Tier Tabs (only for non-historic) */}
            {scope !== 'historico' && (
              <>
                <div
                  className="flex flex-wrap gap-x-5 gap-y-1 mb-3 border-b border-[rgba(245,243,236,0.14)]"
                  role="tablist"
                  aria-label="Categorias de probabilidade"
                >
                  <button
                    type="button"
                    onClick={() => setTier('segura')}
                    className={`cursor-pointer font-body font-semibold text-sm pb-2.5 mr-6 relative transition-colors ${
                      tier === 'segura' ? 'text-[#F5F3EC]' : 'text-[rgba(245,243,236,0.45)] hover:text-[#F5F3EC]'
                    }`}
                  >
                    <span>Segura</span>
                    <span className="font-display ml-1.5 text-xs text-[#4FAE73]">
                      {tierCounts.segura}
                    </span>
                    {tier === 'segura' && (
                      <span className="absolute left-0 right-0 bottom-[-1px] h-[2px] bg-[#4FAE73]" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setTier('moderada')}
                    className={`cursor-pointer font-body font-semibold text-sm pb-2.5 mr-6 relative transition-colors ${
                      tier === 'moderada' ? 'text-[#F5F3EC]' : 'text-[rgba(245,243,236,0.45)] hover:text-[#F5F3EC]'
                    }`}
                  >
                    <span>Moderada</span>
                    <span className="font-display ml-1.5 text-xs text-[#E7B33E]">
                      {tierCounts.moderada}
                    </span>
                    {tier === 'moderada' && (
                      <span className="absolute left-0 right-0 bottom-[-1px] h-[2px] bg-[#E7B33E]" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setTier('ousada')}
                    className={`cursor-pointer font-body font-semibold text-sm pb-2.5 mr-6 relative transition-colors ${
                      tier === 'ousada' ? 'text-[#F5F3EC]' : 'text-[rgba(245,243,236,0.45)] hover:text-[#F5F3EC]'
                    }`}
                  >
                    <span>Ousada</span>
                    <span className="font-display ml-1.5 text-xs text-[#D1594B]">
                      {tierCounts.ousada}
                    </span>
                    {tier === 'ousada' && (
                      <span className="absolute left-0 right-0 bottom-[-1px] h-[2px] bg-[#D1594B]" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setTier('maluca')}
                    className={`cursor-pointer font-body font-semibold text-sm pb-2.5 mr-6 relative transition-colors ${
                      tier === 'maluca' ? 'text-[#F5F3EC]' : 'text-[rgba(245,243,236,0.45)] hover:text-[#F5F3EC]'
                    }`}
                  >
                    <span>Maluca</span>
                    <span className="font-display ml-1.5 text-xs text-[#C084FC]">
                      {tierCounts.maluca}
                    </span>
                    {tier === 'maluca' && (
                      <span className="absolute left-0 right-0 bottom-[-1px] h-[2px] bg-[#C084FC]" />
                    )}
                  </button>
                </div>

                <p className="text-xs text-[rgba(245,243,236,0.45)] mb-5">
                  {tierNoteText()}
                </p>
              </>
            )}

            {/* Slips Grid / History List */}
            {scope === 'historico' ? (
              <HistoryList
                key={historyFilter}
                slips={historySlips}
                timezone={timezone}
                emptyTitle={historyEmpty[historyFilter].title}
                emptyHint={historyEmpty[historyFilter].hint}
                onUpload={setUploadSlip}
                onDelete={handleDeleteSlip}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
                {displayedSlips.length > 0 ? (
                  displayedSlips.map((slip) => (
                    <TicketCard
                      key={slip.id}
                      slip={slip}
                      timezone={timezone}
                      onUpload={setUploadSlip}
                      onDelete={handleDeleteSlip}
                    />
                  ))
                ) : (
                  <div className="col-span-full border border-dashed border-[rgba(245,243,236,0.22)] rounded-lg p-8 text-center text-sm text-[rgba(245,243,236,0.6)]">
                    <div>
                      <p className="font-medium text-[#F5F3EC]">Nenhuma ficha pendente para este horizonte.</p>
                      <p className="text-xs text-[rgba(245,243,236,0.45)] mt-1 mb-4 max-w-md mx-auto">
                        O agendador repÃµe o estoque automaticamente. Pode tambÃ©m gerar uma ficha agora.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleGenerateScope(scope as 'dia' | '2_3_dias' | 'longo')}
                        disabled={generating}
                        className="cursor-pointer inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] disabled:opacity-50"
                      >
                        <Zap className="w-3.5 h-3.5 fill-current" />
                        <span>Gerar ficha agora</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
        </>
      )}

      {activeEngine === 'manual' && (
        <ManualTab
          matches={filteredMatches}
          allLeagues={allLeaguesList}
          activeLeagues={activeLeagues}
          onToggleLeague={handleToggleLeague}
          onlyTopActive={onlyTopActive}
          onOnlyTopLeagues={handleOnlyTopLeagues}
          timezone={timezone}
          manualSlips={manualSlips}
          onUpload={setUploadSlip}
          onDelete={handleDeleteSlip}
          onAnalyzeMatch={handleAnalyzeMatch}
          onSimulateNext={handleSimulateNext}
          isSimulating={isSimulating}
          onAddToCart={handleAddToCart}
          isInCart={isInCart}
          cartCount={cart.length}
          onOpenCart={() => setIsCartOpen(true)}
          tipMarkets={tipMarkets}
          selectedMarket={selectedMarket}
          onMarketChange={setSelectedMarket}
          onGenerateByMarket={handleGenerateManualByMarket}
          generating={generating}
        />
      )}

      {activeEngine === 'jev' && (
        <JevTab
          jevStatus={jevStatus}
          statusLoading={jevStatusLoading}
          statusError={jevStatusError}
          onRefreshStatus={() => {
            void loadJevStatus();
          }}
          onGenerate={handleGenerateJev}
          generating={generatingJev}
          slips={jevSlips}
          allSlips={slips}
          timezone={timezone}
          onUpload={setUploadSlip}
          onDelete={handleDeleteSlip}
        />
      )}

      {activeEngine === 'automacao' && (
        <AutomationTab
          progressions={progressions}
          onRefresh={refreshProgressions}
          onToast={showToast}
        />
      )}

      {/* Carrinho da ficha manual */}
      {cart.length > 0 && (
        <button
          type="button"
          onClick={() => setIsCartOpen(true)}
          className="fixed bottom-6 left-6 z-40 cursor-pointer flex items-center gap-2 px-4 py-3 rounded-full bg-[#173C27] hover:bg-[#20502F] border border-[#E7B33E]/40 text-[#F5F3EC] font-semibold text-sm shadow-2xl active:translate-y-[1px]"
          title="Abrir carrinho de seleÃ§Ãµes para ficha manual"
        >
          <ShoppingCart className="w-4 h-4 text-[#E7B33E]" />
          <span>SeleÃ§Ãµes ({cart.length})</span>
        </button>
      )}

      {/* AÃ§Ã£o global: gerar ficha a partir de qualquer parte do site */}
      {activeEngine === 'principal' && (
        <button
          type="button"
          onClick={() =>
            handleGenerateScope(scope === 'historico' ? 'dia' : (scope as 'dia' | '2_3_dias' | 'longo'))
          }
          disabled={generating}
          className="fixed bottom-6 right-6 z-40 cursor-pointer flex items-center gap-2 px-4 py-3 rounded-full bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] font-semibold text-sm shadow-2xl disabled:opacity-60 active:translate-y-[1px]"
          title="Gerar novas fichas para o horizonte ativo"
        >
          {generating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4 fill-current" />
          )}
          <span>Gerar ficha</span>
        </button>
      )}

      {/* Footer */}
      <footer className="border-t border-[rgba(245,243,236,0.14)] py-7 bg-[#081C13]">
        <div className="max-w-[1180px] mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[rgba(245,243,236,0.45)]">
          <p className="max-w-xl text-center sm:text-left">
            Aposta com responsabilidade. +18. O motor Bilheteria utiliza o <strong>Jev (TypeSafe AI)</strong> para decisÃµes probabilÃ­sticas nÃ£o-autoregressivas e calibraÃ§Ã£o de risco, integrado com dados reais de confronto direto (H2H) e odds de mercado.
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setIsApiModalOpen(true)}
              className="cursor-pointer text-[#E7B33E] hover:underline"
            >
              Configurar Chaves (.env)
            </button>
            <span>Â·</span>
            <span>Jev RLCD v1.0</span>
          </div>
        </div>
      </footer>

      {/* Carrinho / ficha manual */}
      <CustomSlipDrawer
        isOpen={isCartOpen}
        legs={cart}
        defaultScope={activeEngine === 'manual' ? 'dia' : scope === 'historico' ? 'dia' : scope}
        creating={creatingCustom}
        onClose={() => setIsCartOpen(false)}
        onRemove={handleRemoveFromCart}
        onClear={() => setCart([])}
        onCreate={handleCreateCustomSlip}
      />

      {/* Modals */}
      <ApiConfigModal
        isOpen={isApiModalOpen}
        onClose={() => setIsApiModalOpen(false)}
        status={backendStatus}
        onRefresh={() => loadInitialData(true)}
        loading={loading}
      />

      <AiAnalysisModal
        isOpen={isAiAnalysisModalOpen}
        onClose={() => setIsAiAnalysisModalOpen(false)}
        match={selectedMatchForAi}
        analysis={aiAnalysis}
        loading={analyzingAi}
      />

      <AiSmartSlipModal
        isOpen={isAiSlipModalOpen}
        onClose={() => setIsAiSlipModalOpen(false)}
        onGenerate={handleGenerateAiSlip}
        loading={generating}
      />

      <UploadSlipModal
        isOpen={Boolean(uploadSlip)}
        slip={uploadSlip}
        onClose={() => setUploadSlip(null)}
        onUploaded={handleSlipUploaded}
      />
    </div>
  );
}

