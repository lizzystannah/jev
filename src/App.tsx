/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { MatchItem, BetSlip, BackendStatus, AiMatchAnalysis, SlipScope, SlipTier } from './types.js';
import * as api from './api.js';
import { Header } from './components/Header.tsx';
import { HeroStats } from './components/HeroStats.tsx';
import { FixturesSidebar } from './components/FixturesSidebar.tsx';
import { TicketCard } from './components/TicketCard.tsx';
import { ApiConfigModal } from './components/ApiConfigModal.tsx';
import { AiAnalysisModal } from './components/AiAnalysisModal.tsx';
import { AiSmartSlipModal } from './components/AiSmartSlipModal.tsx';
import { Zap, CheckCircle2, RotateCcw, Cpu } from 'lucide-react';
import { getSavedTimezone, saveTimezone } from './utils/timezone.js';
import { leagueRank, isTopTierLeague } from './utils/leagues.js';

export default function App() {
  const [matches, setMatches] = useState<MatchItem[]>([]);
  const [slips, setSlips] = useState<BetSlip[]>([]);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [activeLeagues, setActiveLeagues] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<SlipScope>('dia');
  const [tier, setTier] = useState<SlipTier>('segura');
  const [lastGeneratedTime, setLastGeneratedTime] = useState<string>('');
  const [timezone, setTimezone] = useState<string>(() => getSavedTimezone());

  // Modals & loading states
  const [isApiModalOpen, setIsApiModalOpen] = useState(false);
  const [isAiSlipModalOpen, setIsAiSlipModalOpen] = useState(false);
  const [isAiAnalysisModalOpen, setIsAiAnalysisModalOpen] = useState(false);
  const [selectedMatchForAi, setSelectedMatchForAi] = useState<MatchItem | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AiMatchAnalysis | null>(null);

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
      const [statusData, matchesData, slipsData] = await Promise.all([
        api.fetchBackendStatus(),
        api.fetchMatches(isRefresh),
        api.fetchTickets(),
      ]);

      setBackendStatus(statusData);
      setMatches(matchesData);
      setSlips(slipsData);

      // Initialize all leagues as active and ensure new leagues are included
      setActiveLeagues((prev) => {
        if (prev.size === 0) {
          return new Set(matchesData.map((m) => m.league));
        }
        const next = new Set(prev);
        matchesData.forEach((m) => next.add(m.league));
        return next;
      });

      if (!lastGeneratedTime) {
        setLastGeneratedTime(
          new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
        );
      }
    } catch (err: any) {
      console.error('Erro ao sincronizar com backend:', err);
    } finally {
      if (isRefresh) setLoading(false);
    }
  }, [lastGeneratedTime]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Periodic refresh & live tick (every 4s sync with backend)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [updatedMatches, updatedSlips] = await Promise.all([
          api.fetchMatches(),
          api.fetchTickets(),
        ]);
        setMatches(updatedMatches);
        setSlips(updatedSlips);
      } catch (e) {
        // Silently catch background polling errors
      }
    }, 4000);

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
      const result = await api.generateTickets(targetScope, Array.from(activeLeagues));
      setSlips(result.all);
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
      showToast(`Bilhetes de ${labelMap[targetScope]} calibrados com Jev AI!`);
    } catch (err: any) {
      showToast(err?.message || 'Erro ao gerar bilhetes');
    } finally {
      setGenerating(false);
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
        const statusStr = m.result?.tipWon ? 'Venceu ✓' : 'Falhou ✕';
        showToast(`${m.home} ${m.result?.homeScore}-${m.result?.awayScore} ${m.away} (${statusStr})`);
      } else {
        showToast('Todas as partidas desta lista já foram resolvidas.');
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

  // Filtered pool by longevity horizon & chronological ordering
  const allLeaguesList = Array.from(new Set(matches.map((m) => m.league))).sort(
    (a, b) => leagueRank(a) - leagueRank(b) || a.localeCompare(b)
  );
  const filteredMatches = matches.filter((m) => activeLeagues.has(m.league));

  const poolMatches = filteredMatches
    .filter((m) => {
      if (scope === 'dia') {
        return m.daysFromNow === 0 || (m.kickoffAt - Date.now() <= 24 * 60 * 60 * 1000 && m.kickoffAt >= Date.now() - 2 * 60 * 60 * 1000);
      }
      if (scope === '2_3_dias') {
        return m.daysFromNow >= 1 && m.daysFromNow <= 3;
      }
      if (scope === 'longo') {
        return m.daysFromNow >= 4;
      }
      return true; // historico
    })
    // Ligas principais primeiro, depois cronológico.
    .sort((a, b) => leagueRank(a.league) - leagueRank(b.league) || a.kickoffAt - b.kickoffAt);

  // Toggle "Só principais": filtra para Champions/Europa/EPL/La Liga/Serie A/Bundesliga/Ligue 1+
  const topTierLeagues = allLeaguesList.filter((l) => isTopTierLeague(l));
  const onlyTopActive =
    topTierLeagues.length > 0 &&
    topTierLeagues.every((l) => activeLeagues.has(l)) &&
    Array.from(activeLeagues).every((l) => isTopTierLeague(l));

  const handleOnlyTopLeagues = () => {
    if (onlyTopActive) {
      setActiveLeagues(new Set(allLeaguesList));
    } else if (topTierLeagues.length > 0) {
      setActiveLeagues(new Set(topTierLeagues));
    } else {
      showToast('Sem jogos das ligas principais no horizonte atual');
    }
  };

  // Slips filtering: active tabs (dia, 2_3_dias, longo) ONLY show pending/live tickets
  const slipsInScope = slips.filter((s) => s.scope === scope && s.status === 'pendente');
  const tierCounts: Record<SlipTier, number> = {
    segura: slipsInScope.filter((s) => s.tier === 'segura').length,
    moderada: slipsInScope.filter((s) => s.tier === 'moderada').length,
    ousada: slipsInScope.filter((s) => s.tier === 'ousada').length,
  };

  const displayedSlips =
    scope === 'historico'
      ? slips.filter((s) => s.status !== 'pendente').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
      : slipsInScope.filter((s) => s.tier === tier).sort((a, b) => b.createdAt - a.createdAt);

  // Tier note text matching longevity scope
  const tierNoteText = () => {
    const legsCount =
      scope === 'dia'
        ? tier === 'segura' ? 2 : 3
        : scope === '2_3_dias'
        ? tier === 'segura' ? 3 : 3
        : tier === 'segura' ? 3 : 4;

    const range =
      tier === 'segura'
        ? 'acima de 63% (menor volatilidade e odds seguras)'
        : tier === 'moderada'
        ? 'entre 48% e 63% (ótimo equilíbrio de retorno e probabilidade)'
        : 'Super Acumulada de Alto Retorno (Garantia de Mínimo 10.00 Odds Totais)';

    const spread =
      scope === 'dia'
        ? 'jogos de hoje'
        : scope === '2_3_dias'
        ? 'jogos dos próximos 2 a 3 dias'
        : 'jogos de longo prazo (4+ dias)';

    if (tier === 'ousada') {
      return `Bilhetes de alta odd combinada (${spread}) desenhados com multiplicador expressivo de no mínimo 10.00 odds totais.`;
    }

    return `Bilhetes de ${legsCount} ${spread}, com inferência do Jev de probabilidade calibrada ${range}.`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#081C13] text-[#F5F3EC]">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#0E2A1C] border border-[#E7B33E]/50 text-[#F5F3EC] px-4 py-3 rounded-lg shadow-2xl flex items-center gap-2.5 text-xs font-medium animate-fadeIn">
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
        loading={loading}
        timezone={timezone}
        onTimezoneChange={(tz) => {
          setTimezone(tz);
          saveTimezone(tz);
          showToast(`Fuso horário atualizado para ${tz}`);
        }}
      />

      {/* Hero & Aggregate Stats with Jev & 3-horizon buttons */}
      <HeroStats
        matches={matches}
        slips={slips}
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

            {/* Scope Tabs: Hoje | 2 a 3 Dias | Longo Prazo | Histórico */}
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
                Longo prazo (4d+)
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
                Histórico ({slips.filter((s) => s.status !== 'pendente').length})
              </button>
            </div>

            {/* Validation Ticker Note */}
            <p className="text-xs text-[rgba(245,243,236,0.5)] mb-5 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#4FAE73] animate-pulse-subtle shrink-0" />
              <span>
                Validação automática ativa no backend — cada bilhete muda para{' '}
                <strong className="text-[#4FAE73] font-semibold">ganhou</strong> ou{' '}
                <strong className="text-[#D1594B] font-semibold">perdeu</strong> assim que os seus jogos terminam.
              </span>
            </p>

            {/* Tier Tabs (only for non-historic) */}
            {scope !== 'historico' && (
              <>
                <div
                  className="flex gap-1 mb-3 border-b border-[rgba(245,243,236,0.14)]"
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
                </div>

                <p className="text-xs text-[rgba(245,243,236,0.45)] mb-5">
                  {tierNoteText()}
                </p>
              </>
            )}

            {/* Slips Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
              {displayedSlips.length > 0 ? (
                displayedSlips.map((slip) => <TicketCard key={slip.id} slip={slip} timezone={timezone} />)
              ) : (
                <div className="col-span-full border border-dashed border-[rgba(245,243,236,0.22)] rounded-lg p-8 text-center text-sm text-[rgba(245,243,236,0.6)]">
                  {scope === 'historico' ? (
                    <div>
                      <p className="font-medium text-[#F5F3EC]">Ainda não há bilhetes resolvidos.</p>
                      <p className="text-xs text-[rgba(245,243,236,0.45)] mt-1 max-w-md mx-auto">
                        Gere bilhetes e aguarde a validação automática assim que os jogos terminarem ou clique em "Finalizar 1 jogo" na barra lateral para testar.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="font-medium text-[#F5F3EC]">Nenhum bilhete gerado para este horizonte temporal.</p>
                      <p className="text-xs text-[rgba(245,243,236,0.45)] mt-1 mb-4 max-w-md mx-auto">
                        Acione o motor do Jev para analisar os confrontos e gerar as fichas combinadas.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleGenerateScope(scope as 'dia' | '2_3_dias' | 'longo')}
                        disabled={generating}
                        className="cursor-pointer inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06]"
                      >
                        <Zap className="w-3.5 h-3.5 fill-current" />
                        <span>Gerar bilhetes com Jev</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[rgba(245,243,236,0.14)] py-7 bg-[#081C13]">
        <div className="max-w-[1180px] mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[rgba(245,243,236,0.45)]">
          <p className="max-w-xl text-center sm:text-left">
            Aposta com responsabilidade. +18. O motor Bilheteria utiliza o <strong>Jev (TypeSafe AI)</strong> para decisões probabilísticas não-autoregressivas e calibração de risco, integrado com dados reais de confronto direto (H2H) e odds de mercado.
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setIsApiModalOpen(true)}
              className="cursor-pointer text-[#E7B33E] hover:underline"
            >
              Configurar Chaves (.env)
            </button>
            <span>·</span>
            <span>Jev RLCD v1.0</span>
          </div>
        </div>
      </footer>

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
    </div>
  );
}
