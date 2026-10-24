import React from 'react';
import { MatchItem, MatchTip, SlipScope } from '../types.js';
import { Sparkles, Play, CheckCircle2, XCircle, Clock, Cpu, Plus, Check, ShoppingCart } from 'lucide-react';
import { formatMatchSchedule } from '../utils/timezone.js';

interface FixturesSidebarProps {
  matches: MatchItem[];
  allLeagues: string[];
  activeLeagues: Set<string>;
  onToggleLeague: (league: string) => void;
  onlyTopActive: boolean;
  onOnlyTopLeagues: () => void;
  scope: SlipScope;
  onAnalyzeMatch: (match: MatchItem) => void;
  onSimulateNext: () => void;
  isSimulating: boolean;
  timezone?: string;
  onAddToCart: (match: MatchItem, tip: MatchTip) => void;
  isInCart: (matchId: string, market: string) => boolean;
  cartCount: number;
  onOpenCart: () => void;
}

function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return 'a decorrer';
  const totalMin = Math.floor(diff / (1000 * 60));
  if (totalMin >= 24 * 60) {
    const days = Math.floor(totalMin / (24 * 60));
    const hours = Math.floor((totalMin % (24 * 60)) / 60);
    return `em ${days}d ${hours}h`;
  }
  if (totalMin >= 60) {
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return `em ${hours}h ${mins}m`;
  }
  const totalSec = Math.ceil(diff / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `em ${m}m ${s.toString().padStart(2, '0')}s`;
}

export const FixturesSidebar: React.FC<FixturesSidebarProps> = ({
  matches,
  allLeagues,
  activeLeagues,
  onToggleLeague,
  onlyTopActive,
  onOnlyTopLeagues,
  scope,
  onAnalyzeMatch,
  onSimulateNext,
  isSimulating,
  timezone = 'Africa/Luanda',
  onAddToCart,
  isInCart,
  cartCount,
  onOpenCart,
}) => {
  const title =
    scope === 'dia'
      ? 'Jogos de Hoje'
      : scope === '2_3_dias'
      ? 'Jogos de 2 a 3 Dias'
      : scope === 'longo'
      ? 'Jogos de Longo Prazo'
      : 'Histórico de Confrontos';

  const uniqueMatches = React.useMemo(() => {
    const seen = new Set<string>();
    return matches.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [matches]);

  const [visibleCount, setVisibleCount] = React.useState(60);

  React.useEffect(() => {
    setVisibleCount(60);
  }, [scope]);

  const pendingMatches = React.useMemo(
    () => uniqueMatches.filter((m) => m.status !== 'resolved'),
    [uniqueMatches]
  );
  const visibleMatches = uniqueMatches.slice(0, visibleCount);

  return (
    <aside className="w-full">
      {/* Title & Count */}
      <div className="flex items-baseline justify-between mb-3.5">
        <h2 className="font-display text-2xl font-semibold tracking-wide text-[#F5F3EC]">
          {title}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[rgba(245,243,236,0.4)]">
            {uniqueMatches.length} confronto{uniqueMatches.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={onOpenCart}
            className="cursor-pointer flex items-center gap-1.5 rounded-full border border-[#E7B33E]/50 bg-[#E7B33E]/10 px-2.5 py-1 text-[11px] font-semibold text-[#E7B33E] hover:bg-[#E7B33E]/20 transition-colors"
            title="Abrir carrinho de seleções para ficha manual"
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            <span>Carrinho ({cartCount})</span>
          </button>
        </div>
      </div>

      {/* League Filter Pills */}
      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Filtrar por liga">
        <button
          key="__top"
          type="button"
          onClick={onOnlyTopLeagues}
          title="Mostrar só ligas principais (Champions, Europa, EPL, La Liga, Serie A, Bundesliga, Ligue 1)"
          className={`cursor-pointer text-xs px-3 py-1.5 rounded-full transition-all border font-semibold ${
            onlyTopActive
              ? 'bg-[#E7B33E] border-[#E7B33E] text-[#3A2A06]'
              : 'bg-transparent border-[#E7B33E]/50 text-[#E7B33E] hover:bg-[#E7B33E]/10'
          }`}
        >
          ★ Só principais
        </button>
        {allLeagues.map((league) => {
          const isActive = activeLeagues.has(league);
          return (
            <button
              key={league}
              type="button"
              onClick={() => onToggleLeague(league)}
              className={`cursor-pointer text-xs px-3 py-1.5 rounded-full transition-all border ${
                isActive
                  ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-medium'
                  : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.55)] hover:text-[#F5F3EC] hover:border-[rgba(245,243,236,0.35)]'
              }`}
            >
              {league}
            </button>
          );
        })}
      </div>

      {/* Live Simulation Trigger */}
      {pendingMatches.length > 0 && (
        <div className="mb-3.5 p-2.5 rounded bg-[#0E2A1C] border border-[rgba(245,243,236,0.12)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs text-[rgba(245,243,236,0.7)]">
            <Clock className="w-3.5 h-3.5 text-[#E7B33E]" />
            <span>Validação automática ativa</span>
          </div>
          <button
            type="button"
            onClick={onSimulateNext}
            disabled={isSimulating}
            className="cursor-pointer text-xs font-semibold px-2.5 py-1 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] transition-colors flex items-center gap-1 disabled:opacity-50"
            title="Força a resolução do próximo jogo para testar a validação do bilhete"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>{isSimulating ? 'A simular...' : 'Finalizar 1 jogo'}</span>
          </button>
        </div>
      )}

      {/* Fixtures List */}
      <div className="flex flex-col gap-2.5 max-h-[640px] overflow-y-auto pr-1">
        {uniqueMatches.length === 0 ? (
          <div className="p-6 text-center rounded border border-dashed border-[rgba(245,243,236,0.2)] text-xs text-[rgba(245,243,236,0.5)]">
            Nenhuma partida encontrada neste horizonte temporal com os filtros selecionados.
          </div>
        ) : (
          visibleMatches.map((m) => {
            const dayLabel = formatMatchSchedule(m.kickoffAt, timezone, m.daysFromNow);

            const isResolved = m.status === 'resolved';
            const tipWon = m.result?.tipWon;
            const h2h = m.context?.h2h;

            return (
              <div
                key={m.id}
                className="bg-[#0E2A1C] border border-[rgba(245,243,236,0.12)] rounded p-3 transition-colors hover:border-[rgba(245,243,236,0.25)]"
              >
                {/* Meta */}
                <div className="flex justify-between items-center text-[11.5px] text-[rgba(245,243,236,0.4)] mb-1.5">
                  <span className="truncate mr-2 font-medium">
                    {m.league}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[#E7B33E] font-medium text-[11px]">{dayLabel}</span>
                    <button
                      type="button"
                      onClick={() => onAnalyzeMatch(m)}
                      className="cursor-pointer text-[10.5px] text-[#E7B33E] hover:underline flex items-center gap-0.5"
                      title="Ver análise detalhada com IA"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      <span>Análise</span>
                    </button>
                  </div>
                </div>

                {/* Teams */}
                <div className="text-[14px] font-medium text-[#F5F3EC] flex items-center justify-between">
                  <span>
                    {m.home}{' '}
                    <span className="text-[rgba(245,243,236,0.4)] font-normal text-xs mx-0.5">
                      vs
                    </span>{' '}
                    {m.away}
                  </span>
                  {isResolved && m.result && (
                    <span className="font-display text-sm px-1.5 py-0.5 rounded bg-[#173C27] text-[#F5F3EC]">
                      {m.result.homeScore} - {m.result.awayScore}
                    </span>
                  )}
                </div>

                {/* H2H & Context Pill */}
                {h2h && (
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[rgba(245,243,236,0.45)]">
                    <span>
                      H2H: {h2h.homeWins}V - {h2h.draws}E - {h2h.awayWins}D
                    </span>
                    <span>·</span>
                    <span>{h2h.avgGoals} golos/jogo</span>
                  </div>
                )}

                {/* Tip & Jev Output */}
                <div className="mt-2 pt-2 border-t border-dashed border-[rgba(245,243,236,0.12)] flex items-center justify-between text-xs">
                  <span className="text-[rgba(245,243,236,0.7)] truncate mr-2">
                    {m.tip.label} ·{' '}
                    <strong className="text-[#F5F3EC]">
                      odd {m.tip.odds != null ? m.tip.odds.toFixed(2) : '—'}
                    </strong>
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[#E7B33E] font-semibold font-display text-sm">
                      {m.tip.prob}%
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#173C27] text-[#4FAE73] font-medium border border-[#4FAE73]/30 flex items-center gap-0.5" title="Calibrado pelo motor Jev AI">
                      <Cpu className="w-2.5 h-2.5 text-[#E7B33E]" />
                      <span>Jev</span>
                    </span>
                  </div>
                </div>

                {/* Tips disponíveis para ficha manual */}
                {!isResolved && (
                  <div className="mt-2 pt-2 border-t border-dashed border-[rgba(245,243,236,0.12)]">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)] mb-1.5">
                      <span>Tips disponíveis</span>
                      <span>{(m.tips && m.tips.length > 0 ? m.tips : [m.tip]).length}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(m.tips && m.tips.length > 0 ? m.tips : [m.tip]).map((tip) => {
                        const inCart = isInCart(m.id, tip.market);
                        const noOdd = tip.odds == null;
                        return (
                          <div
                            key={tip.market}
                            className={`flex items-center gap-1 rounded border px-1.5 py-1 text-[10.5px] ${
                              inCart
                                ? 'border-[#4FAE73]/60 bg-[rgba(79,174,115,0.14)]'
                                : 'border-[rgba(245,243,236,0.14)] bg-[#081C13]/60'
                            }`}
                          >
                            <span
                              className="max-w-[110px] truncate text-[rgba(245,243,236,0.75)]"
                              title={tip.label}
                            >
                              {tip.label}
                            </span>
                            <span className="font-semibold text-[#E7B33E]">{tip.prob}%</span>
                            <span className="font-mono text-[rgba(245,243,236,0.5)]">
                              {tip.odds != null ? tip.odds.toFixed(2) : '—'}
                            </span>
                            <button
                              type="button"
                              onClick={() => onAddToCart(m, tip)}
                              disabled={noOdd || inCart}
                              title={
                                noOdd
                                  ? 'sem odd real'
                                  : inCart
                                  ? 'já adicionada ao carrinho'
                                  : 'adicionar ao carrinho'
                              }
                              className={`cursor-pointer ml-0.5 flex h-4 w-4 items-center justify-center rounded ${
                                inCart
                                  ? 'text-[#4FAE73]'
                                  : noOdd
                                  ? 'text-[rgba(245,243,236,0.25)] cursor-not-allowed'
                                  : 'text-[#E7B33E] hover:bg-[#E7B33E]/20'
                              }`}
                            >
                              {inCart ? (
                                <Check className="w-3 h-3" />
                              ) : (
                                <Plus className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Status */}
                <div className="mt-1.5 text-[11.5px] flex items-center gap-1.5">
                  {isResolved ? (
                    tipWon ? (
                      <span className="text-[#4FAE73] font-medium flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> ✓ a tip venceu
                      </span>
                    ) : (
                      <span className="text-[#D1594B] font-medium flex items-center gap-1">
                        <XCircle className="w-3 h-3" /> ✕ a tip falhou
                      </span>
                    )
                  ) : (
                    <span className="text-[rgba(245,243,236,0.45)] flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      começa em {formatCountdown(m.kickoffAt)}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}

        {uniqueMatches.length > visibleCount && (
          <button
            type="button"
            onClick={() => setVisibleCount((current) => current + 60)}
            className="cursor-pointer mt-1 w-full rounded border border-[rgba(245,243,236,0.2)] bg-[#0E2A1C] px-3 py-2 text-xs font-medium text-[#E7B33E] hover:bg-[#173C27] transition-colors"
          >
            Mostrar mais ({uniqueMatches.length - visibleCount} restantes)
          </button>
        )}
      </div>
    </aside>
  );
};
