import React, { useMemo, useState } from 'react';
import { BetSlip, MatchItem, MatchTip } from '../types.js';
import { FixturesSidebar } from './FixturesSidebar.js';
import { EngineSlipsPanel } from './EngineSlipsPanel.js';
import { matchInScope, SCOPE_OPTIONS, ScopeOption } from '../utils/slips.js';

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
  onAnalyzeMatch: (match: MatchItem) => void;
  onSimulateNext: () => void;
  isSimulating: boolean;
  onAddToCart: (match: MatchItem, tip: MatchTip) => void;
  isInCart: (matchId: string, market: string) => boolean;
  cartCount: number;
  onOpenCart: () => void;
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
  onAnalyzeMatch,
  onSimulateNext,
  isSimulating,
  onAddToCart,
  isInCart,
  cartCount,
  onOpenCart,
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
          o escopo e o tier na criação da ficha. O carrinho mantém as seleções entre escopos.
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
          emptyTitle="Ainda não criaste fichas manuais."
          emptyHint="Adiciona tips ao carrinho na lista de jogos ao lado e cria a primeira ficha manual."
          historyTitle="Histórico manual"
          onUpload={onUpload}
        />
      </div>
    </div>
  );
};
