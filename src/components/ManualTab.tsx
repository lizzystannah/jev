import React, { useMemo, useState } from 'react';
import { BetSlip, MatchItem, MatchTip, TipMarket } from '../types.js';
import { FixturesSidebar } from './FixturesSidebar.js';
import { EngineSlipsPanel } from './EngineSlipsPanel.js';
import { matchInScope, SCOPE_OPTIONS, ScopeOption, scopeLabel } from '../utils/slips.js';
import { Zap, Loader2 } from 'lucide-react';

interface ManualTabProps {
  matches: MatchItem[];
  allLeagues: string[];
  activeLeagues: Set<string>;
  onToggleLeague: (league: string) => void;
  onlyTopActive: boolean;
  onOnlyTopLeagues: () => void;
  timezone: string;
  manualSlips: BetSlip[];
  onUpload: (slip: BetSlip) => void;
  onDelete: (slip: BetSlip) => void;
  onAnalyzeMatch: (match: MatchItem) => void;
  onSimulateNext: () => void;
  isSimulating: boolean;
  onAddToCart: (match: MatchItem, tip: MatchTip) => void;
  isInCart: (matchId: string, market: string) => boolean;
  cartCount: number;
  onOpenCart: () => void;
  tipMarkets: TipMarket[];
  selectedMarket: string;
  onMarketChange: (market: string) => void;
  onGenerateByMarket: (scope: ScopeOption, market: string) => void;
  generating: boolean;
}

export const ManualTab: React.FC<ManualTabProps> = ({
  matches,
  allLeagues,
  activeLeagues,
  onToggleLeague,
  onlyTopActive,
  onOnlyTopLeagues,
  timezone,
  manualSlips,
  onUpload,
  onDelete,
  onAnalyzeMatch,
  onSimulateNext,
  isSimulating,
  onAddToCart,
  isInCart,
  cartCount,
  onOpenCart,
  tipMarkets,
  selectedMarket,
  onMarketChange,
  onGenerateByMarket,
  generating,
}) => {
  const [browseScope, setBrowseScope] = useState<ScopeOption>('dia');

  const scopedMatches = useMemo(
    () => matches.filter((match) => matchInScope(match, browseScope)),
    [matches, browseScope]
  );

  return (
    <div className="max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-9">
      <div className="mb-6 rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] px-5 py-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-[#173C27] text-[#E7B33E] border border-[#E7B33E]/30">
            Motor Manual
          </span>
        </div>
        <h1 className="font-display text-2xl sm:text-3xl font-semibold text-[#F5F3EC]">
          Monta a tua ficha jogo a jogo
        </h1>
        <p className="mt-1.5 text-sm text-[rgba(245,243,236,0.6)] max-w-2xl">
          Escolhe o horizonte para explorar os jogos, adiciona as tips ao carrinho e define
          o escopo e o tier na criaÃ§Ã£o da ficha. O carrinho mantÃ©m as seleÃ§Ãµes entre escopos.
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="flex flex-col gap-1.5 flex-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-[rgba(245,243,236,0.55)]">
              Tipo de tip / mercado
            </span>
            <select
              value={selectedMarket}
              onChange={(e) => onMarketChange(e.target.value)}
              disabled={generating}
              className="cursor-pointer bg-[#081C13] border border-[rgba(245,243,236,0.2)] rounded px-3 py-2 text-sm text-[#F5F3EC] focus:outline-none focus:border-[#E7B33E] disabled:opacity-60"
            >
              <option value="">Automático (recomendada)</option>
              {tipMarkets.map((m) => (
                <option key={m.market} value={m.market}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => onGenerateByMarket(browseScope, selectedMarket)}
            disabled={generating}
            className="cursor-pointer inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] disabled:opacity-50 active:translate-y-[1px] shrink-0"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4 fill-current" />
            )}
            <span>Gerar ficha manual</span>
          </button>
        </div>
        <p className="mt-2.5 text-[11px] text-[rgba(245,243,236,0.5)]">
          Horizonte ativo: <strong className="text-[#F5F3EC]">{scopeLabel(browseScope)}</strong>{' '}
          (muda nas abas de escopo ao lado). As fichas geradas ficam nesta aba (Manual), separadas
          das fichas automáticas da Principal.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-8 items-start">
        <div>
          <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Escopo dos jogos">
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setBrowseScope(option.id)}
                className={`cursor-pointer text-xs px-3.5 py-1.5 rounded-full border transition-all ${
                  browseScope === option.id
                    ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold shadow-sm'
                    : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <FixturesSidebar
            matches={scopedMatches}
            allLeagues={allLeagues}
            activeLeagues={activeLeagues}
            onToggleLeague={onToggleLeague}
            onlyTopActive={onlyTopActive}
            onOnlyTopLeagues={onOnlyTopLeagues}
            scope={browseScope}
            onAnalyzeMatch={onAnalyzeMatch}
            onSimulateNext={onSimulateNext}
            isSimulating={isSimulating}
            timezone={timezone}
            onAddToCart={onAddToCart}
            isInCart={isInCart}
            cartCount={cartCount}
            onOpenCart={onOpenCart}
          />
        </div>

        <EngineSlipsPanel
          slips={manualSlips}
          timezone={timezone}
          title="Fichas manuais"
          subtitle="Fichas criadas a partir das tips que escolheste, agrupadas por escopo e tier."
          emptyTitle="Ainda nÃ£o criaste fichas manuais."
          emptyHint="Adiciona tips ao carrinho na lista de jogos ao lado e cria a primeira ficha manual."
          historyTitle="HistÃ³rico manual"
          onUpload={onUpload}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
};

