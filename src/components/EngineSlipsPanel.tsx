import React, { useMemo, useState } from 'react';
import { BetSlip, HistoryFilter, SlipTier } from '../types.js';
import { TicketCard } from './TicketCard.js';
import { HistoryList } from './HistoryList.js';
import { TierTabs } from './TierTabs.js';
import { byMostRecent, SCOPE_OPTIONS, ScopeOption, scopeLabel } from '../utils/slips.js';

interface EngineSlipsPanelProps {
  slips: BetSlip[];
  timezone: string;
  title: string;
  subtitle?: string;
  emptyTitle: string;
  emptyHint: string;
  historyTitle: string;
  onUpload: (slip: BetSlip) => void;
  onDelete: (slip: BetSlip) => void;
}

const emptyTierCounts = (): Record<SlipTier, number> => ({
  segura: 0,
  moderada: 0,
  ousada: 0,
  maluca: 0,
  compostas: 0,
});

const emptyByScope = (): Record<ScopeOption, BetSlip[]> => ({
  dia: [],
  '2_3_dias': [],
  longo: [],
});

const historyFilterLabel: Record<HistoryFilter, string> = {
  andamento: 'Em andamento',
  ganhas: 'Ganhas',
  perdidas: 'Perdidas',
  vencidas: 'Vencidas',
};

const historyEmpty: Record<HistoryFilter, { title: string; hint: string }> = {
  andamento: {
    title: 'Nenhuma ficha em andamento.',
    hint: 'As fichas pendentes deste motor aparecem aqui atÃ© serem resolvidas.',
  },
  ganhas: {
    title: 'Ainda nÃ£o hÃ¡ fichas ganhas.',
    hint: 'Quando todas as pernas acertarem, a ficha passa para esta vista.',
  },
  perdidas: {
    title: 'Ainda nÃ£o hÃ¡ fichas perdidas.',
    hint: 'Uma ficha cai para aqui quando a primeira perna falha.',
  },
  vencidas: {
    title: 'Ainda nÃ£o hÃ¡ fichas vencidas.',
    hint: 'Fichas sem resoluÃ§Ã£o dentro do prazo ficam aqui.',
  },
};

export const EngineSlipsPanel: React.FC<EngineSlipsPanelProps> = ({
  slips,
  timezone,
  title,
  subtitle,
  emptyTitle,
  emptyHint,
  historyTitle,
  onUpload,
  onDelete,
}) => {
  const [tierByScope, setTierByScope] = useState<Record<ScopeOption, SlipTier>>({
    dia: 'segura',
    '2_3_dias': 'segura',
    longo: 'segura',
  });
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('andamento');

  const grouped = useMemo(() => {
    const next = emptyByScope();
    for (const slip of slips) {
      if (slip.status !== 'pendente') continue;
      next[slip.scope].push(slip);
    }
    next.dia.sort((a, b) => b.createdAt - a.createdAt);
    next['2_3_dias'].sort((a, b) => b.createdAt - a.createdAt);
    next.longo.sort((a, b) => b.createdAt - a.createdAt);
    return next;
  }, [slips]);

  const tierCounts = useMemo(() => {
    const next: Record<ScopeOption, Record<SlipTier, number>> = {
      dia: emptyTierCounts(),
      '2_3_dias': emptyTierCounts(),
      longo: emptyTierCounts(),
    };
    for (const option of SCOPE_OPTIONS) {
      for (const slip of grouped[option.id]) {
        next[option.id][slip.tier] += 1;
      }
    }
    return next;
  }, [grouped]);

  const historyBuckets = useMemo<Record<HistoryFilter, BetSlip[]>>(() => {
    const next: Record<HistoryFilter, BetSlip[]> = {
      andamento: [],
      ganhas: [],
      perdidas: [],
      vencidas: [],
    };
    for (const slip of slips) {
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
  }, [slips]);

  const pendingTotal = grouped.dia.length + grouped['2_3_dias'].length + grouped.longo.length;
  const historySlips = historyBuckets[historyFilter];

  return (
    <section className="min-w-0">
      <div className="mb-4">
        <h2 className="font-display text-2xl font-semibold tracking-wide text-[#F5F3EC]">
          {title}
        </h2>
        {subtitle && (
          <p className="text-xs text-[rgba(245,243,236,0.5)] mt-1">{subtitle}</p>
        )}
      </div>

      {pendingTotal === 0 ? (
        <div className="border border-dashed border-[rgba(245,243,236,0.22)] rounded-lg p-6 text-center mb-7">
          <p className="font-medium text-sm text-[#F5F3EC]">{emptyTitle}</p>
          <p className="text-xs text-[rgba(245,243,236,0.45)] mt-1 max-w-md mx-auto">{emptyHint}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-7 mb-7">
          {SCOPE_OPTIONS.map((option) => {
            const scopeSlips = grouped[option.id];
            if (scopeSlips.length === 0) return null;
            const activeTier = tierByScope[option.id];
            const displayed = scopeSlips.filter((slip) => slip.tier === activeTier);

            return (
              <div key={option.id}>
                <div className="flex items-center justify-between gap-3 mb-2.5">
                  <h3 className="font-display text-base font-semibold text-[#F5F3EC]">
                    {scopeLabel(option.id)}
                  </h3>
                  <span className="text-[11px] text-[rgba(245,243,236,0.45)]">
                    {scopeSlips.length} pendente{scopeSlips.length === 1 ? '' : 's'}
                  </span>
                </div>

                <TierTabs
                  tier={activeTier}
                  counts={tierCounts[option.id]}
                  onChange={(nextTier) =>
                    setTierByScope((prev) => ({ ...prev, [option.id]: nextTier }))
                  }
                  className="mb-3"
                />

                {displayed.length === 0 ? (
                  <div className="border border-dashed border-[rgba(245,243,236,0.18)] rounded p-4 text-xs text-[rgba(245,243,236,0.5)]">
                    Sem fichas {activeTier} em {scopeLabel(option.id)}.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
                    {displayed.map((slip) => (
                      <TicketCard
                        key={slip.id}
                        slip={slip}
                        timezone={timezone}
                        onUpload={onUpload}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-[rgba(245,243,236,0.14)] pt-5">
        <h3 className="font-display text-xl font-semibold text-[#F5F3EC] mb-3">
          {historyTitle}
        </h3>
        <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Filtrar histÃ³rico do motor">
          {(['andamento', 'ganhas', 'perdidas', 'vencidas'] as HistoryFilter[]).map((filter) => {
            const active = historyFilter === filter;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setHistoryFilter(filter)}
                className={`cursor-pointer text-xs px-3 py-1.5 rounded border transition-all ${
                  active
                    ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold'
                    : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                }`}
              >
                {historyFilterLabel[filter]}
                <span className="ml-1.5 opacity-70">({historyBuckets[filter].length})</span>
              </button>
            );
          })}
        </div>

        <HistoryList
          key={historyFilter}
          slips={historySlips}
          timezone={timezone}
          emptyTitle={historyEmpty[historyFilter].title}
          emptyHint={historyEmpty[historyFilter].hint}
          onUpload={onUpload}
          onDelete={onDelete}
        />
      </div>
    </section>
  );
};

