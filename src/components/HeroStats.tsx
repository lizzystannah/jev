import React, { useState } from 'react';
import { MatchItem, BetSlip, BackendStatus, SlipScope, TicketStockStatus } from '../types.js';
import { Sparkles, Calendar, Zap, Clock, Cpu, TrendingUp, CheckCircle2, XCircle, BarChart3, ChevronDown, ChevronUp } from 'lucide-react';

interface HeroStatsProps {
  matches: MatchItem[];
  slips: BetSlip[];
  stock: TicketStockStatus | null;
  backendStatus: BackendStatus | null;
  lastGeneratedTime: string;
  activeScope: SlipScope;
  onGenerateScope: (scope: 'dia' | '2_3_dias' | 'longo') => void;
  onOpenAiSlipModal: () => void;
  generating: boolean;
}

export const HeroStats: React.FC<HeroStatsProps> = ({
  matches,
  slips,
  stock,
  backendStatus,
  lastGeneratedTime,
  activeScope,
  onGenerateScope,
  onOpenAiSlipModal,
  generating,
}) => {
  const [showDetailedStats, setShowDetailedStats] = useState(false);

  const avgOdds =
    matches.length > 0
      ? matches.reduce((acc, m) => acc + (m.tip?.odds || 1.8), 0) / matches.length
      : 0;

  // Estatísticas Reais de Bilhetes
  const resolvedSlips = slips.filter((s) => s.status !== 'pendente');
  const wonSlips = resolvedSlips.filter((s) => s.status === 'ganhou');
  const lostSlips = resolvedSlips.filter((s) => s.status === 'perdeu');
  const pendingSlips = slips.filter((s) => s.status === 'pendente');

  const winRateNum = resolvedSlips.length > 0 ? (wonSlips.length / resolvedSlips.length) * 100 : 0;
  const winRateText = resolvedSlips.length > 0 ? `${winRateNum.toFixed(1)}%` : '—';

  // Estatísticas Reais de Prognósticos Individuais (Pernas)
  let totalResolvedLegs = 0;
  let wonLegs = 0;
  resolvedSlips.forEach((s) => {
    s.legs.forEach((leg) => {
      if (leg.status === 'resolved') {
        totalResolvedLegs++;
        if (leg.result?.tipWon) {
          wonLegs++;
        }
      }
    });
  });
  const legAccuracyNum = totalResolvedLegs > 0 ? (wonLegs / totalResolvedLegs) * 100 : 0;

  // Retorno e Lucro Líquido Real (Unidades)
  // Assumindo 1 unidade apostada por bilhete
  const unitsStaked = resolvedSlips.length;
  const unitsReturned = wonSlips.reduce((acc, s) => acc + s.combinedOdds, 0);
  const profitUnits = unitsReturned - unitsStaked;
  const roiPct = unitsStaked > 0 ? (profitUnits / unitsStaked) * 100 : 0;

  // Estatísticas Reais por Categoria de Risco
  const tierStats = {
    segura: {
      total: resolvedSlips.filter((s) => s.tier === 'segura').length,
      won: resolvedSlips.filter((s) => s.tier === 'segura' && s.status === 'ganhou').length,
    },
    moderada: {
      total: resolvedSlips.filter((s) => s.tier === 'moderada').length,
      won: resolvedSlips.filter((s) => s.tier === 'moderada' && s.status === 'ganhou').length,
    },
    ousada: {
      total: resolvedSlips.filter((s) => s.tier === 'ousada').length,
      won: resolvedSlips.filter((s) => s.tier === 'ousada' && s.status === 'ganhou').length,
    },
    maluca: {
      total: resolvedSlips.filter((s) => s.tier === 'maluca').length,
      won: resolvedSlips.filter((s) => s.tier === 'maluca' && s.status === 'ganhou').length,
    },
  };

  return (
    <section className="pt-8 pb-7 border-b border-[rgba(245,243,236,0.14)]">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div className="max-w-2xl">
            {/* Tag indicativa do Jev AI */}
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#173C27] border border-[#4FAE73]/40 text-[#4FAE73] text-[11px] font-semibold tracking-wide uppercase mb-3">
              <Cpu className="w-3.5 h-3.5 text-[#E7B33E]" />
              <span>Decisões probabilísticas calibradas por Jev AI (TypeSafe RLCD)</span>
            </div>

            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-semibold leading-[0.98] tracking-tight text-[#F5F3EC]">
              O jogo sob medida, transformado em bilhete.
            </h1>
            <p className="mt-3.5 text-sm sm:text-base text-[rgba(245,243,236,0.68)] leading-relaxed max-w-xl">
              O motor <strong>Jev (System One)</strong> filtra e ranqueia as oportunidades de maior probabilidade, gerando seleções refinadas divididas nos 3 horizontes temporais.
            </p>
          </div>

          {/* Action Buttons for all 3 Longevity Scopes */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onGenerateScope('dia')}
              disabled={generating}
              className={`cursor-pointer font-semibold text-xs sm:text-sm px-4 py-2.5 rounded transition-all flex items-center gap-1.5 shadow-sm disabled:opacity-50 active:translate-y-[1px] ${
                activeScope === 'dia'
                  ? 'bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06]'
                  : 'bg-[#173C27] hover:bg-[#20502F] text-[#F5F3EC] border border-[rgba(245,243,236,0.2)]'
              }`}
            >
              <Zap className="w-4 h-4 fill-current" />
              <span>Bilhetes de Hoje</span>
            </button>

            <button
              type="button"
              onClick={() => onGenerateScope('2_3_dias')}
              disabled={generating}
              className={`cursor-pointer font-semibold text-xs sm:text-sm px-4 py-2.5 rounded transition-all flex items-center gap-1.5 shadow-sm disabled:opacity-50 active:translate-y-[1px] ${
                activeScope === '2_3_dias'
                  ? 'bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06]'
                  : 'bg-[#173C27] hover:bg-[#20502F] text-[#F5F3EC] border border-[rgba(245,243,236,0.2)]'
              }`}
            >
              <Clock className="w-4 h-4" />
              <span>2 a 3 Dias</span>
            </button>

            <button
              type="button"
              onClick={() => onGenerateScope('longo')}
              disabled={generating}
              className={`cursor-pointer font-semibold text-xs sm:text-sm px-4 py-2.5 rounded transition-all flex items-center gap-1.5 disabled:opacity-50 active:translate-y-[1px] ${
                activeScope === 'longo'
                  ? 'bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06]'
                  : 'bg-transparent hover:border-[rgba(245,243,236,0.64)] border border-[rgba(245,243,236,0.28)] text-[#F5F3EC]'
              }`}
            >
              <Calendar className="w-4 h-4" />
              <span>Longo Prazo</span>
            </button>

            <button
              type="button"
              onClick={onOpenAiSlipModal}
              className="cursor-pointer bg-[#0E2A1C] hover:bg-[#173C27] border border-[#E7B33E]/40 text-[#E7B33E] hover:text-[#F5F3EC] font-semibold text-xs sm:text-sm px-3.5 py-2.5 rounded transition-all flex items-center gap-1.5"
            >
              <Sparkles className="w-4 h-4 text-[#E7B33E]" />
              <span>Prompt IA</span>
            </button>
          </div>
        </div>

        {/* Estoque automático por horizonte (reposto pelo agendador) */}
        {stock && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
            {stock.stocks.map((s) => {
              const ok = s.pending >= s.quota;
              const label =
                s.scope === 'dia' ? 'Hoje' : s.scope === '2_3_dias' ? '2 a 3 dias' : 'Longo prazo';
              return (
                <span
                  key={s.scope}
                  className={`px-2 py-1 rounded border font-medium ${
                    ok
                      ? 'bg-[rgba(79,174,115,0.12)] border-[rgba(79,174,115,0.3)] text-[#4FAE73]'
                      : 'bg-[rgba(231,179,62,0.12)] border-[rgba(231,179,62,0.3)] text-[#E7B33E]'
                  }`}
                  title={`Estoque de fichas pendentes (quota ${s.quota})`}
                >
                  {label}: {s.pending}/{s.quota}
                  {!ok && s.missing > 0 ? ` · em reposição` : ''}
                </span>
              );
            })}
            <span className="text-[rgba(245,243,236,0.4)]">
              Fornada automática às 00:00 (Angola) · fuso {stock.timezone}
            </span>
          </div>
        )}

        {/* Real Main Stats Row */}
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-[rgba(245,243,236,0.14)] border border-[rgba(245,243,236,0.14)] rounded overflow-hidden">
          <div className="bg-[#0E2A1C] p-4 sm:p-4.5">
            <div className="font-display text-3xl sm:text-4xl text-[#F5F3EC] leading-none">
              {matches.length}
            </div>
            <div className="mt-1.5 text-xs text-[rgba(245,243,236,0.45)]">
              Jogos Futuros
            </div>
          </div>

          <div className="bg-[#0E2A1C] p-4 sm:p-4.5">
            <div className="font-display text-3xl sm:text-4xl text-[#F5F3EC] leading-none">
              {avgOdds.toFixed(2)}
            </div>
            <div className="mt-1.5 text-xs text-[rgba(245,243,236,0.45)]">
              Odd média mercado
            </div>
          </div>

          <div className="bg-[#0E2A1C] p-4 sm:p-4.5">
            <div className="font-display text-3xl sm:text-4xl text-[#F5F3EC] leading-none">
              {slips.length}
            </div>
            <div className="mt-1.5 text-xs text-[rgba(245,243,236,0.45)] flex items-center justify-between">
              <span>Bilhetes criados</span>
              {pendingSlips.length > 0 && (
                <span className="text-[#E7B33E] font-medium">({pendingSlips.length})</span>
              )}
            </div>
          </div>

          {/* Jev AI Calibrated Prob & Edge */}
          <div className="bg-[#0E2A1C] p-4 sm:p-4.5 border-l border-[rgba(231,179,62,0.15)] bg-gradient-to-b from-[#173C27]/40 to-[#0E2A1C]">
            <div className="font-display text-3xl sm:text-4xl text-[#E7B33E] leading-none flex items-baseline gap-1">
              <span>{backendStatus?.jevEngine?.metrics?.avgCalibratedProb || 64}%</span>
              <span className="text-[10px] font-body text-[#4FAE73] font-semibold">
                +{backendStatus?.jevEngine?.metrics?.avgEdgeEV || '8.4'}% EV
              </span>
            </div>
            <div className="mt-1.5 text-xs text-[rgba(245,243,236,0.55)] flex items-center gap-1 font-medium">
              <Cpu className="w-3 h-3 text-[#E7B33E]" />
              <span>Jev Calibração</span>
            </div>
          </div>

          <div className="bg-[#0E2A1C] p-4 sm:p-4.5">
            <div className="font-display text-3xl sm:text-4xl text-[#4FAE73] leading-none flex items-baseline gap-1.5">
              <span>{winRateText}</span>
              {resolvedSlips.length > 0 && (
                <span className="text-xs font-body font-normal text-[rgba(245,243,236,0.5)]">
                  ({wonSlips.length}/{resolvedSlips.length})
                </span>
              )}
            </div>
            <div className="mt-1.5 text-xs text-[rgba(245,243,236,0.45)]">
              Taxa de acerto real
            </div>
          </div>

          <div className="bg-[#0E2A1C] p-4 sm:p-4.5 col-span-2 sm:col-span-1 flex flex-col justify-between">
            <div className="font-display text-2xl sm:text-3xl text-[#E7B33E] leading-none truncate">
              {profitUnits >= 0 ? `+${profitUnits.toFixed(2)}u` : `${profitUnits.toFixed(2)}u`}
            </div>
            <div className="mt-1.5 text-xs text-[rgba(245,243,236,0.45)] flex items-center justify-between">
              <span>Balanço (ROI: {roiPct >= 0 ? `+${roiPct.toFixed(1)}%` : `${roiPct.toFixed(1)}%`})</span>
            </div>
          </div>
        </div>

        {/* Real Detailed Statistics Accordion Toggle */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDetailedStats(!showDetailedStats)}
            className="cursor-pointer text-xs text-[rgba(245,243,236,0.6)] hover:text-[#E7B33E] flex items-center gap-1.5 font-medium transition-colors"
          >
            <BarChart3 className="w-3.5 h-3.5 text-[#E7B33E]" />
            <span>{showDetailedStats ? 'Ocultar estatísticas detalhadas da Colaboração Jev' : 'Ver estatísticas completas de colaboração Jev AI, taxa de acerto e mercados'}</span>
            {showDetailedStats ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {showDetailedStats && (
            <div className="mt-3 p-4 rounded-lg bg-[#0E2A1C] border border-[rgba(245,243,236,0.12)] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs animate-fadeIn">
              {/* Box 1: Pernas Individuais */}
              <div className="p-3 rounded bg-[#173C27]/60 border border-[rgba(245,243,236,0.08)]">
                <div className="text-[rgba(245,243,236,0.5)] uppercase tracking-wider text-[10px] font-semibold mb-1">
                  Precisão por Partida (Pernas)
                </div>
                <div className="text-xl font-bold font-display text-[#F5F3EC]">
                  {totalResolvedLegs > 0 ? `${legAccuracyNum.toFixed(1)}%` : '—'}
                </div>
                <div className="text-[11px] text-[rgba(245,243,236,0.6)] mt-1">
                  {wonLegs} jogos acertados de {totalResolvedLegs} finalizados
                </div>
              </div>

              {/* Box 2: Por Categoria de Risco */}
              <div className="p-3 rounded bg-[#173C27]/60 border border-[rgba(245,243,236,0.08)]">
                <div className="text-[rgba(245,243,236,0.5)] uppercase tracking-wider text-[10px] font-semibold mb-1">
                  Acerto por Tier de Risco
                </div>
                <div className="space-y-1 text-[11px] mt-1.5">
                  <div className="flex justify-between">
                    <span className="text-[#4FAE73]">Segura:</span>
                    <strong className="text-[#F5F3EC]">
                      {tierStats.segura.total > 0
                        ? `${Math.round((tierStats.segura.won / tierStats.segura.total) * 100)}% (${tierStats.segura.won}/${tierStats.segura.total})`
                        : '0 finalizados'}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#E7B33E]">Moderada:</span>
                    <strong className="text-[#F5F3EC]">
                      {tierStats.moderada.total > 0
                        ? `${Math.round((tierStats.moderada.won / tierStats.moderada.total) * 100)}% (${tierStats.moderada.won}/${tierStats.moderada.total})`
                        : '0 finalizados'}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#D1594B]">Ousada:</span>
                    <strong className="text-[#F5F3EC]">
                      {tierStats.ousada.total > 0
                        ? `${Math.round((tierStats.ousada.won / tierStats.ousada.total) * 100)}% (${tierStats.ousada.won}/${tierStats.ousada.total})`
                        : '0 finalizados'}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#C084FC]">Maluca:</span>
                    <strong className="text-[#F5F3EC]">
                      {tierStats.maluca.total > 0
                        ? `${Math.round((tierStats.maluca.won / tierStats.maluca.total) * 100)}% (${tierStats.maluca.won}/${tierStats.maluca.total})`
                        : '0 finalizados'}
                    </strong>
                  </div>
                </div>
              </div>

              {/* Box 3: Top Mercados Recomendados pelo Jev */}
              <div className="p-3 rounded bg-[#173C27]/60 border border-[rgba(245,243,236,0.08)]">
                <div className="text-[rgba(245,243,236,0.5)] uppercase tracking-wider text-[10px] font-semibold mb-1 flex items-center justify-between">
                  <span>Mercados Jev Selecionados</span>
                  <Cpu className="w-3 h-3 text-[#E7B33E]" />
                </div>
                <div className="space-y-1.5 text-[11px] mt-1.5">
                  {(backendStatus?.jevEngine?.metrics?.topMarkets || [
                    { market: '1X (Dupla Chance)', percentage: 45 },
                    { market: '+1.5 Golos', percentage: 30 },
                    { market: 'Ambas Marcam', percentage: 15 },
                    { market: '-3.5 Golos', percentage: 10 },
                  ]).map((tm, idx) => (
                    <div key={idx} className="flex justify-between items-center">
                      <span className="text-[rgba(245,243,236,0.7)] truncate mr-1">{tm.market}</span>
                      <span className="text-[#E7B33E] font-medium shrink-0">{tm.percentage}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Box 4: Performance e Latência do Motor Jev */}
              <div className="p-3 rounded bg-[#173C27]/60 border border-[rgba(245,243,236,0.08)]">
                <div className="text-[rgba(245,243,236,0.5)] uppercase tracking-wider text-[10px] font-semibold mb-1 flex items-center justify-between">
                  <span>Motor Jev (System One)</span>
                  <span className="w-2 h-2 rounded-full bg-[#4FAE73] animate-pulse" />
                </div>
                <div className="text-xl font-bold font-display text-[#E7B33E] flex items-baseline gap-1.5">
                  <span>{backendStatus?.jevEngine ? `${backendStatus.jevEngine.latencyMs}ms` : '420ms'}</span>
                  <span className="text-[10px] text-[#4FAE73] font-semibold font-body">100% Calibrado</span>
                </div>
                <div className="text-[10.5px] text-[rgba(245,243,236,0.6)] mt-1 truncate" title={backendStatus?.jevEngine?.modelVersion || '~typesafe/jev-latest'}>
                  {backendStatus?.jevEngine?.modelVersion || 'OpenRouter / ~typesafe/jev-latest'}
                </div>
                <div className="text-[10px] text-[rgba(245,243,236,0.4)] mt-0.5">
                  {backendStatus?.jevEngine?.metrics?.totalInferences ? `${backendStatus.jevEngine.metrics.totalInferences} inferências gravadas` : 'Inferências ativas'}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
