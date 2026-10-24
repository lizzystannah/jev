import React, { useState } from 'react';
import { BetSlip, MatchItem } from '../types.js';
import { Copy, Check, Sparkles, Cpu, Clock, Calendar, CheckCircle2, XCircle, Activity, Hourglass, UploadCloud } from 'lucide-react';
import { formatDateTimeInTz, formatMatchSchedule } from '../utils/timezone.js';

interface TicketCardProps {
  slip: BetSlip;
  timezone?: string;
  onUpload?: (slip: BetSlip) => void;
}

function formatKzShort(value: number): string {
  return `${new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 2 }).format(value)} Kz`;
}

function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return 'a decorrer';
  const totalSec = Math.ceil(diff / 1000);
  const hours = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (hours > 0) return `${hours}h ${m}m`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const TicketCard: React.FC<TicketCardProps> = ({ slip, timezone = 'Africa/Luanda', onUpload }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(slip.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tierColors: Record<string, string> = {
    segura: '#4FAE73',
    moderada: '#E7B33E',
    ousada: '#D1594B',
    maluca: '#C084FC',
  };
  const tierColor = tierColors[slip.tier] || '#E7B33E';

  const isWon = slip.status === 'ganhou';
  const isLost = slip.status === 'perdeu';
  const isExpired = slip.status === 'expirado';
  const isPending = slip.status === 'pendente';

  const scopeLabel =
    slip.scope === 'dia'
      ? 'Hoje'
      : slip.scope === '2_3_dias'
      ? '2 a 3 Dias'
      : 'Longo Prazo';

  const totalLegs = slip.legs.length;
  const resolvedLegs = slip.legs.filter((l) => l.status === 'resolved');
  const wonLegs = slip.legs.filter((l) => l.status === 'resolved' && l.result?.tipWon);
  const resolvedCount = resolvedLegs.length;

  // Status dinâmico baseado exclusivamente na realização dos jogos
  const getTicketStatusBadge = () => {
    if (isWon) {
      return {
        text: `Bilhete Vencedor (${wonLegs.length}/${totalLegs} acertos)`,
        bg: 'bg-[rgba(79,174,115,0.15)] text-[#4FAE73] border-[rgba(79,174,115,0.3)]',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-[#4FAE73]" />,
      };
    }
    if (isLost) {
      return {
        text: `Bilhete Finalizado (${wonLegs.length}/${totalLegs} acertos)`,
        bg: 'bg-[rgba(209,89,75,0.15)] text-[#D1594B] border-[rgba(209,89,75,0.3)]',
        icon: <XCircle className="w-3.5 h-3.5 text-[#D1594B]" />,
      };
    }
    if (isExpired) {
      return {
        text: `Vencida / Expirada (${resolvedCount}/${totalLegs} jogos finalizados)`,
        bg: 'bg-[rgba(245,243,236,0.06)] text-[rgba(245,243,236,0.65)] border-[rgba(245,243,236,0.18)]',
        icon: <Hourglass className="w-3.5 h-3.5 text-[rgba(245,243,236,0.55)]" />,
      };
    }
    if (resolvedCount > 0) {
      return {
        text: `Em andamento (${resolvedCount}/${totalLegs} jogos finalizados)`,
        bg: 'bg-[rgba(231,179,62,0.15)] text-[#E7B33E] border-[rgba(231,179,62,0.3)]',
        icon: <Activity className="w-3.5 h-3.5 text-[#E7B33E] animate-pulse" />,
      };
    }
    return {
      text: `Acompanhamento ativo (${totalLegs} jogos pendentes)`,
      bg: 'bg-[rgba(245,243,236,0.06)] text-[rgba(245,243,236,0.7)] border-[rgba(245,243,236,0.12)]',
      icon: <Clock className="w-3.5 h-3.5 text-[#4FAE73]" />,
    };
  };

  const statusBadge = getTicketStatusBadge();

  return (
    <article
      className="relative bg-[#173C27] border border-[rgba(245,243,236,0.14)] rounded p-5 overflow-hidden transition-transform duration-150 hover:-translate-y-0.5 shadow-md flex flex-col justify-between"
      style={{ borderTop: `3px solid ${tierColor}` }}
    >
      <div>
        {/* Ticket Header */}
        <div className="flex justify-between items-center mb-2.5 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] uppercase tracking-wider font-bold"
              style={{ color: tierColor }}
            >
              {slip.tier}
            </span>
            <span className="text-[10.5px] text-[rgba(245,243,236,0.45)] border-l border-[rgba(245,243,236,0.25)] pl-2">
              {scopeLabel}
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(79,174,115,0.12)] text-[#4FAE73] font-medium flex items-center gap-0.5"
              title={slip.isAiGenerated === false ? 'Odds e probabilidades implícitas do mercado' : 'Decisão calibrada via Jev System One'}
            >
              {slip.isAiGenerated === false ? (
                <>
                  <Sparkles className="w-2.5 h-2.5" /> Mercado
                </>
              ) : (
                <>
                  <Cpu className="w-2.5 h-2.5" /> Jev AI
                </>
              )}
            </span>
            {slip.customTitle && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E] font-medium flex items-center gap-0.5">
                <Sparkles className="w-2.5 h-2.5" /> Estratégico
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {isWon && (
              <span className="text-[11px] font-bold tracking-wide px-2 py-0.5 rounded bg-[rgba(79,174,115,0.18)] text-[#4FAE73]">
                GANHOU
              </span>
            )}
            {isLost && (
              <span className="text-[11px] font-bold tracking-wide px-2 py-0.5 rounded bg-[rgba(209,89,75,0.18)] text-[#D1594B]">
                PERDEU
              </span>
            )}
            {isExpired && (
              <span className="text-[11px] font-bold tracking-wide px-2 py-0.5 rounded bg-[rgba(245,243,236,0.1)] text-[rgba(245,243,236,0.7)]">
                VENCIDA
              </span>
            )}
            {isPending && (
              <button
                type="button"
                onClick={handleCopy}
                className="cursor-pointer text-[11px] font-mono text-[rgba(245,243,236,0.45)] hover:text-[#F5F3EC] flex items-center gap-1"
                title="Copiar código do bilhete"
              >
                <span>#{slip.id}</span>
                {copied ? <Check className="w-3 h-3 text-[#4FAE73]" /> : <Copy className="w-3 h-3 text-[rgba(245,243,236,0.45)]" />}
              </button>
            )}
          </div>
        </div>

        {/* Creation Date */}
        <div className="mb-2 text-[10.5px] text-[rgba(245,243,236,0.45)] flex items-center gap-1.5">
          <Calendar className="w-3 h-3 text-[rgba(245,243,236,0.4)]" />
          <span>Criada em {formatDateTimeInTz(slip.createdAt, timezone)}</span>
          {slip.resolvedAt && (
            <>
              <span className="text-[rgba(245,243,236,0.25)]">·</span>
              <span>Fechada em {formatDateTimeInTz(slip.resolvedAt, timezone)}</span>
            </>
          )}
        </div>

        {/* Live Match Realization Status Banner */}
        <div className={`mb-3 px-2.5 py-1.5 rounded border flex items-center justify-between gap-2 text-[11px] ${statusBadge.bg}`}>
          <div className="flex items-center gap-1.5 font-medium">
            {statusBadge.icon}
            <span>{statusBadge.text}</span>
          </div>
          <span className="text-[10px] text-[rgba(245,243,236,0.5)] font-mono">
            {isPending ? 'Conclusão ao apito final' : isExpired ? 'Sem resolução a tempo' : 'Finalizado'}
          </span>
        </div>

        {/* Custom Title if present */}
        {slip.customTitle && (
          <div className="mb-2.5 text-xs font-semibold text-[#E7B33E]">
            {slip.customTitle}
          </div>
        )}

        {/* Legs List */}
        <div className="flex flex-col gap-2.5">
          {slip.legs.map((leg, idx) => {
            const legResolved = leg.status === 'resolved';
            const legWon = leg.result?.tipWon;

            return (
              <div key={`${leg.id}-${idx}`} className="p-2.5 rounded bg-[#0E2A1C]/50 border border-[rgba(245,243,236,0.06)] flex justify-between items-start gap-2 text-xs">
                <div className="min-w-0 pr-1 flex-1">
                  {/* Match Date & Time Badge */}
                  <div className="flex items-center gap-1.5 text-[10.5px] text-[rgba(245,243,236,0.55)] mb-1">
                    <Calendar className="w-3 h-3 text-[#E7B33E] shrink-0" />
                    <span className="font-semibold text-[#F5F3EC] bg-[rgba(231,179,62,0.12)] px-1.5 py-0.2 rounded">
                      {formatMatchSchedule(leg.kickoffAt, timezone, leg.daysFromNow)}
                    </span>
                    <span className="text-[rgba(245,243,236,0.3)]">·</span>
                    <span className="truncate">{leg.league}</span>
                  </div>

                  <div className="text-[13.5px] font-medium text-[#F5F3EC] truncate">
                    {leg.home} × {leg.away}
                  </div>
                  <div className="text-[12.5px] text-[#E7B33E] font-medium truncate mt-0.5">
                    Prognóstico: {leg.tip.label}
                  </div>

                  <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                    {legResolved ? (
                      legWon ? (
                        <span className="text-[#4FAE73] font-medium flex items-center gap-0.5">
                          ✓ Acertou ({leg.result?.homeScore}-{leg.result?.awayScore})
                        </span>
                      ) : (
                        <span className="text-[#D1594B] font-medium flex items-center gap-0.5">
                          ✕ Falhou ({leg.result?.homeScore}-{leg.result?.awayScore})
                        </span>
                      )
                    ) : (
                      <span className="text-[rgba(245,243,236,0.45)] flex items-center gap-1">
                        ⏳ Início em {formatCountdown(leg.kickoffAt)}
                      </span>
                    )}

                    {leg.jevInference ? (
                      <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[rgba(79,174,115,0.15)] text-[#4FAE73] font-medium flex items-center gap-1 border border-[#4FAE73]/30">
                        <Cpu className="w-2.5 h-2.5 text-[#E7B33E]" />
                        <span>Jev: {leg.jevInference.calibratedProb}% prob ({leg.jevInference.expectedValueEdge >= 0 ? `+${leg.jevInference.expectedValueEdge}% EV` : `${leg.jevInference.expectedValueEdge}% EV`})</span>
                      </span>
                    ) : (
                      <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[rgba(231,179,62,0.12)] text-[#E7B33E] font-medium flex items-center gap-1 border border-[#E7B33E]/20">
                        <Cpu className="w-2.5 h-2.5" />
                        <span>{slip.isAiGenerated === false ? 'Prob. mercado' : 'Jev'}: {leg.tip.prob}% prob</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="font-display text-xl text-[#F5F3EC] shrink-0 font-medium pl-1 text-right">
                  <div className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)] font-body">
                    Odd
                  </div>
                  {leg.tip.odds != null ? leg.tip.odds.toFixed(2) : '—'}
                </div>
              </div>
            );
          })}
        </div>

        {/* AI Rationale / Strategy */}
        {slip.rationale && (
          <div className="mt-3 p-2 rounded bg-[#0E2A1C]/70 border border-[rgba(245,243,236,0.08)] text-[11px] text-[rgba(245,243,236,0.65)] italic leading-tight">
            💡 {slip.rationale}
          </div>
        )}
      </div>

      {/* Ticket Footer / Tear */}
      <div className="mt-4 pt-3.5 border-t border-[rgba(245,243,236,0.1)] flex justify-between items-end">
        <div>
          <div className="text-[10.5px] text-[rgba(245,243,236,0.4)]">
            Odd combinada
          </div>
          <div className="font-display text-3xl font-bold leading-none text-[#F5F3EC] mt-0.5">
            {slip.combinedOdds.toFixed(2)}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[10.5px] text-[rgba(245,243,236,0.4)]">
            Probabilidade Jev
          </div>
          <div
            className="font-display text-2xl font-bold leading-none mt-0.5"
            style={{ color: tierColor }}
          >
            {slip.combinedProb}%
          </div>
        </div>
      </div>

      {/* Premier Bet: subir a ficha / estado */}
      {isPending && (
        <div className="mt-3 pt-3 border-t border-[rgba(245,243,236,0.1)] flex items-center justify-between gap-2">
          <div className="min-w-0">
            {slip.upload?.status === 'in_progress' ? (
              <span
                className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E] border border-[rgba(231,179,62,0.3)] inline-flex items-center gap-1"
                title="Submissão em curso. Se o servidor reiniciou, verifica as apostas abertas na Premier Bet."
              >
                <Activity className="w-3 h-3 animate-pulse" />
                Em curso na Premier Bet...
              </span>
            ) : slip.upload?.status === 'placed' ? (
              <span
                className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-[rgba(79,174,115,0.15)] text-[#4FAE73] border border-[rgba(79,174,115,0.3)] inline-flex items-center gap-1"
                title={slip.upload.betId ? `ID da aposta: ${slip.upload.betId}` : undefined}
              >
                <CheckCircle2 className="w-3 h-3" />
                No ar · {formatKzShort(slip.upload.stake)}
              </span>
            ) : slip.upload?.status === 'unknown' ? (
              <span
                className="text-[10.5px] font-semibold px-2 py-0.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E] border border-[rgba(231,179,62,0.3)] inline-flex items-center gap-1"
                title="Verifica as apostas abertas na Premier Bet antes de tentar novamente."
              >
                <Activity className="w-3 h-3" />
                Confirmar na Premier Bet
              </span>
            ) : slip.upload?.status === 'dry_run' ? (
              <span
                className="text-[10.5px] font-medium px-2 py-0.5 rounded bg-[rgba(245,243,236,0.07)] text-[rgba(245,243,236,0.65)] border border-[rgba(245,243,236,0.18)]"
                title="A última tentativa foi apenas um teste; nenhuma aposta foi colocada."
              >
                Teste (sem aposta)
              </span>
            ) : slip.upload?.status === 'failed' ? (
              <span
                className="text-[10.5px] font-medium px-2 py-0.5 rounded bg-[rgba(209,89,75,0.15)] text-[#D1594B] border border-[rgba(209,89,75,0.3)]"
                title={slip.upload.message}
              >
                Última tentativa falhou
              </span>
            ) : (
              <span className="text-[10.5px] text-[rgba(245,243,236,0.45)]">
                Ainda não subida para a Premier Bet
              </span>
            )}
          </div>

          {onUpload && (
            <button
              type="button"
              onClick={() => onUpload(slip)}
              className="cursor-pointer shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded bg-[#E7B33E] text-[#3A2A06] hover:bg-[#F0C869] transition-colors"
              title="Entrar na Premier Bet, preencher a ficha e colocar a aposta"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              <span>
                {slip.upload?.status === 'placed' ? 'Subir novamente' : 'Subir ficha'}
              </span>
            </button>
          )}
        </div>
      )}
    </article>
  );
};
