import React, { useState } from 'react';
import { BetSlip } from '../types.js';
import {
  Activity,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Hourglass,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import { formatDateTimeInTz, formatMatchSchedule } from '../utils/timezone.js';

interface HistoryListProps {
  slips: BetSlip[];
  timezone: string;
  emptyTitle: string;
  emptyHint: string;
  onUpload?: (slip: BetSlip) => void;
}

function formatKzShort(value: number): string {
  return `${new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 2 }).format(value)} Kz`;
}

function statusMeta(status: BetSlip['status']) {
  switch (status) {
    case 'ganhou':
      return {
        label: 'Ganha',
        bg: 'bg-[rgba(79,174,115,0.15)] text-[#4FAE73] border-[rgba(79,174,115,0.3)]',
        icon: <CheckCircle2 className="w-3 h-3" />,
      };
    case 'perdeu':
      return {
        label: 'Perdida',
        bg: 'bg-[rgba(209,89,75,0.15)] text-[#D1594B] border-[rgba(209,89,75,0.3)]',
        icon: <XCircle className="w-3 h-3" />,
      };
    case 'expirado':
      return {
        label: 'Vencida',
        bg: 'bg-[rgba(245,243,236,0.07)] text-[rgba(245,243,236,0.65)] border-[rgba(245,243,236,0.18)]',
        icon: <Hourglass className="w-3 h-3" />,
      };
    default:
      return {
        label: 'Em andamento',
        bg: 'bg-[rgba(231,179,62,0.15)] text-[#E7B33E] border-[rgba(231,179,62,0.3)]',
        icon: <Activity className="w-3 h-3" />,
      };
  }
}

const scopeLabel = (scope: BetSlip['scope']) =>
  scope === 'dia' ? 'Hoje' : scope === '2_3_dias' ? '2 a 3 Dias' : 'Longo Prazo';

const tierColor: Record<string, string> = {
  segura: '#4FAE73',
  moderada: '#E7B33E',
  ousada: '#D1594B',
  maluca: '#C084FC',
};

export const HistoryList: React.FC<HistoryListProps> = ({
  slips,
  timezone,
  emptyTitle,
  emptyHint,
  onUpload,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (slips.length === 0) {
    return (
      <div className="border border-dashed border-[rgba(245,243,236,0.22)] rounded-lg p-8 text-center">
        <p className="font-medium text-sm text-[#F5F3EC]">{emptyTitle}</p>
        <p className="text-xs text-[rgba(245,243,236,0.45)] mt-1 max-w-md mx-auto">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] text-[rgba(245,243,236,0.45)]">
        <span>{slips.length} ficha(s) nesta vista</span>
        {expanded.size > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(new Set())}
            className="cursor-pointer hover:text-[#E7B33E] transition-colors"
          >
            Recolher tudo
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {slips.map((slip) => {
          const meta = statusMeta(slip.status);
          const isOpen = expanded.has(slip.id);
          const color = tierColor[slip.tier] || '#E7B33E';

          return (
            <li
              key={slip.id}
              className="rounded border border-[rgba(245,243,236,0.14)] bg-[#173C27] overflow-hidden"
              style={{ borderLeft: `3px solid ${color}` }}
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => toggle(slip.id)}
                  className="min-w-0 flex-1 text-left px-3.5 py-3 flex items-center gap-3 cursor-pointer hover:bg-[#20502F]/40 transition-colors"
                  aria-expanded={isOpen}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border flex items-center gap-1 ${meta.bg}`}
                      >
                        {meta.icon}
                        {meta.label}
                      </span>
                      <span
                        className="text-[10.5px] uppercase tracking-wider font-bold"
                        style={{ color }}
                      >
                        {slip.tier}
                      </span>
                      <span className="text-[10.5px] text-[rgba(245,243,236,0.45)]">
                        {scopeLabel(slip.scope)}
                      </span>
                      <span className="text-[12.5px] font-medium text-[#F5F3EC] truncate">
                        {slip.customTitle || `Ficha ${slip.id}`}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[10.5px] text-[rgba(245,243,236,0.5)]">
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        Criada em {formatDateTimeInTz(slip.createdAt, timezone)}
                      </span>
                      {slip.resolvedAt && (
                        <span>Fechada em {formatDateTimeInTz(slip.resolvedAt, timezone)}</span>
                      )}
                      <span>{slip.legs.length} jogos</span>
                      <span>Odd {slip.combinedOdds.toFixed(2)}x</span>
                      <span>Prob. {slip.combinedProb}%</span>
                      {slip.upload?.status === 'in_progress' && (
                        <span className="text-[#E7B33E] font-medium">Em curso na Premier Bet</span>
                      )}
                      {slip.upload?.status === 'placed' && (
                        <span className="text-[#4FAE73] font-medium">
                          No ar · {formatKzShort(slip.upload.stake)}
                        </span>
                      )}
                      {slip.upload?.status === 'unknown' && (
                        <span className="text-[#E7B33E] font-medium">Confirmar na Premier Bet</span>
                      )}
                      {slip.upload?.status === 'dry_run' && (
                        <span className="text-[rgba(245,243,236,0.55)]">Teste (sem aposta)</span>
                      )}
                    </div>
                  </div>

                  <span className="font-mono text-[10.5px] text-[rgba(245,243,236,0.4)] hidden sm:inline">
                    #{slip.id}
                  </span>
                  {isOpen ? (
                    <ChevronUp className="w-4 h-4 text-[#E7B33E] shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-[rgba(245,243,236,0.55)] shrink-0" />
                  )}
                </button>

                {!isOpen && slip.status === 'pendente' && onUpload && (
                  <div className="flex shrink-0 items-center pr-3 pl-1">
                    <button
                      type="button"
                      onClick={() => onUpload(slip)}
                      className="cursor-pointer inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded bg-[#E7B33E] text-[#3A2A06] hover:bg-[#F0C869] transition-colors"
                      title="Entrar na Premier Bet, preencher a ficha e colocar a aposta"
                    >
                      <UploadCloud className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Subir ficha</span>
                      <span className="sm:hidden">Subir</span>
                    </button>
                  </div>
                )}
              </div>

              {isOpen && (
                <div className="border-t border-[rgba(245,243,236,0.1)] px-3.5 py-3 bg-[#0E2A1C]/40">
                  <div className="flex flex-col gap-2">
                    {slip.legs.map((leg, idx) => {
                      const resolved = leg.status === 'resolved';
                      const won = leg.result?.tipWon;
                      return (
                        <div
                          key={`${leg.id}-${idx}`}
                          className="px-2.5 py-2 rounded bg-[#0E2A1C]/70 border border-[rgba(245,243,236,0.06)] flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-[10.5px] text-[rgba(245,243,236,0.5)] mb-0.5">
                              <span className="text-[#F5F3EC]">
                                {formatMatchSchedule(leg.kickoffAt, timezone, leg.daysFromNow)}
                              </span>
                              <span className="text-[rgba(245,243,236,0.25)]">·</span>
                              <span className="truncate">{leg.league}</span>
                            </div>
                            <div className="text-[12.5px] font-medium text-[#F5F3EC] truncate">
                              {leg.home} × {leg.away}
                            </div>
                            <div className="text-[11.5px] text-[#E7B33E] truncate">
                              {leg.tip.label} · odd{' '}
                              {leg.tip.odds != null ? leg.tip.odds.toFixed(2) : '—'} · {leg.tip.prob}%
                            </div>
                            <div className="text-[10.5px] mt-0.5">
                              {resolved ? (
                                won ? (
                                  <span className="text-[#4FAE73] font-medium">
                                    ✓ Acertou ({leg.result?.homeScore}-{leg.result?.awayScore})
                                  </span>
                                ) : (
                                  <span className="text-[#D1594B] font-medium">
                                    ✕ Falhou ({leg.result?.homeScore}-{leg.result?.awayScore})
                                  </span>
                                )
                              ) : (
                                <span className="text-[rgba(245,243,236,0.45)]">
                                  {leg.status === 'live' ? 'A decorrer' : 'Pendente'}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {slip.rationale && (
                    <div className="mt-2.5 p-2 rounded bg-[#0E2A1C]/70 border border-[rgba(245,243,236,0.08)] text-[11px] text-[rgba(245,243,236,0.65)] italic leading-tight">
                      💡 {slip.rationale}
                    </div>
                  )}

                  {slip.status === 'pendente' && onUpload && (
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <span className="text-[10.5px] text-[rgba(245,243,236,0.5)]">
                        {slip.upload?.status === 'in_progress'
                          ? 'Submissão em curso na Premier Bet...'
                          : slip.upload?.status === 'placed'
                            ? `No ar na Premier Bet · ${formatKzShort(slip.upload.stake)}`
                            : slip.upload?.status === 'unknown'
                              ? 'Colocação por confirmar na Premier Bet'
                              : slip.upload?.status === 'dry_run'
                                ? 'Última tentativa foi apenas um teste'
                                : slip.upload?.status === 'failed'
                                  ? 'A última tentativa falhou'
                                  : 'Ainda não subida para a Premier Bet'}
                      </span>
                      <button
                        type="button"
                        onClick={() => onUpload(slip)}
                        className="cursor-pointer shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded border border-[#E7B33E]/60 text-[#E7B33E] hover:bg-[#E7B33E] hover:text-[#3A2A06] transition-colors"
                        title="Entrar na Premier Bet, preencher a ficha e colocar a aposta"
                      >
                        <UploadCloud className="w-3.5 h-3.5" />
                        {slip.upload?.status === 'placed' ? 'Subir novamente' : 'Subir ficha'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
