import React, { useMemo, useState } from 'react';
import { BetSlip, JevStatus, SlipScope } from '../types.js';
import { EngineSlipsPanel } from './EngineSlipsPanel.js';
import { SCOPE_OPTIONS, ScopeOption, engineOf } from '../utils/slips.js';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  RefreshCw,
  Zap,
} from 'lucide-react';

interface JevTabProps {
  jevStatus: JevStatus | null;
  statusLoading: boolean;
  statusError: boolean;
  onRefreshStatus: () => void;
  onGenerate: (scope: ScopeOption, limit: number) => Promise<void>;
  generating: boolean;
  slips: BetSlip[];
  allSlips: BetSlip[];
  timezone: string;
  onUpload: (slip: BetSlip) => void;
}

interface EngineSummary {
  total: number;
  won: number;
  lost: number;
  expired: number;
  pending: number;
}

const emptySummary = (): EngineSummary => ({
  total: 0,
  won: 0,
  lost: 0,
  expired: 0,
  pending: 0,
});

const scopeLabels: Record<SlipScope, string> = {
  dia: 'Hoje',
  '2_3_dias': '2 a 3 Dias',
  longo: 'Longo Prazo',
  historico: 'Histórico',
};

const SummaryCard: React.FC<{ title: string; summary: EngineSummary; accent: string }> = ({
  title,
  summary,
  accent,
}) => {
  const decided = summary.won + summary.lost;
  const rate = decided > 0 ? (summary.won / decided) * 100 : null;

  return (
    <div className="rounded border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-[11px] uppercase tracking-wider font-semibold text-[rgba(245,243,236,0.55)]">
          {title}
        </span>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: accent }} />
      </div>
      <div className="grid grid-cols-2 gap-y-2 text-xs">
        <span className="text-[rgba(245,243,236,0.55)]">Fichas</span>
        <span className="text-right font-semibold text-[#F5F3EC]">{summary.total}</span>
        <span className="text-[rgba(245,243,236,0.55)]">Ganhas</span>
        <span className="text-right font-semibold text-[#4FAE73]">{summary.won}</span>
        <span className="text-[rgba(245,243,236,0.55)]">Perdidas</span>
        <span className="text-right font-semibold text-[#D1594B]">{summary.lost}</span>
        <span className="text-[rgba(245,243,236,0.55)]">Pendentes</span>
        <span className="text-right font-semibold text-[#E7B33E]">{summary.pending}</span>
        <span className="text-[rgba(245,243,236,0.55)]">Vencidas</span>
        <span className="text-right font-semibold text-[rgba(245,243,236,0.75)]">
          {summary.expired}
        </span>
      </div>
      <div className="mt-3 pt-2.5 border-t border-[rgba(245,243,236,0.1)] flex items-center justify-between text-[11px]">
        <span className="text-[rgba(245,243,236,0.5)]">Taxa de acerto</span>
        <span className="font-display text-base font-semibold" style={{ color: accent }}>
          {rate == null ? '—' : `${rate.toFixed(1)}%`}
        </span>
      </div>
    </div>
  );
};

export const JevTab: React.FC<JevTabProps> = ({
  jevStatus,
  statusLoading,
  statusError,
  onRefreshStatus,
  onGenerate,
  generating,
  slips,
  allSlips,
  timezone,
  onUpload,
}) => {
  const [scope, setScope] = useState<ScopeOption>('dia');
  const [limit, setLimit] = useState(4);

  const summary = useMemo(() => {
    const principal = emptySummary();
    const jev = emptySummary();
    for (const slip of allSlips) {
      const engine = engineOf(slip);
      if (engine !== 'local' && engine !== 'jev') continue;
      const target = engine === 'jev' ? jev : principal;
      target.total += 1;
      if (slip.status === 'ganhou') target.won += 1;
      else if (slip.status === 'perdeu') target.lost += 1;
      else if (slip.status === 'expirado') target.expired += 1;
      else target.pending += 1;
    }
    return { principal, jev };
  }, [allSlips]);

  const configured = Boolean(jevStatus?.configured);
  const canGenerate = configured && !generating;
  const showUnavailable = !statusLoading && !jevStatus;

  return (
    <div className="max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-9">
      <div className="rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] px-5 py-4 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Cpu className="w-4 h-4 text-[#E7B33E]" />
              <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-[#173C27] text-[#E7B33E] border border-[#E7B33E]/30">
                Motor JEV
              </span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-semibold text-[#F5F3EC]">
              Fichas geradas pelo modelo JEV
            </h1>
            <p className="mt-1.5 text-sm text-[rgba(245,243,236,0.6)] max-w-2xl">
              Gera fichas com o motor remoto do JEV e compara o desempenho com o motor
              principal.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefreshStatus}
            disabled={statusLoading}
            className="cursor-pointer inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded border border-[rgba(245,243,236,0.2)] bg-[#081C13] text-[rgba(245,243,236,0.7)] hover:text-[#F5F3EC] disabled:opacity-50"
            title="Voltar a consultar o estado do JEV"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
            <span>Verificar estado</span>
          </button>
        </div>

        {statusLoading ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-[rgba(245,243,236,0.55)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#E7B33E]" />
            <span>A consultar o estado do motor JEV...</span>
          </div>
        ) : showUnavailable || statusError ? (
          <div className="mt-4 flex items-start gap-2 rounded border border-[rgba(231,179,62,0.35)] bg-[rgba(231,179,62,0.1)] px-3 py-2.5 text-xs text-[#E7B33E]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Estado do JEV indisponível.</p>
              <p className="mt-0.5 text-[rgba(245,243,236,0.7)]">
                Confirma o backend e define <code className="font-mono">JEV_API_KEY</code> e{' '}
                <code className="font-mono">JEV_MODEL</code> no ficheiro <code className="font-mono">.env</code>.
              </p>
            </div>
          </div>
        ) : !configured ? (
          <div className="mt-4 flex items-start gap-2 rounded border border-[rgba(231,179,62,0.35)] bg-[rgba(231,179,62,0.1)] px-3 py-2.5 text-xs text-[#E7B33E]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">JEV não configurado.</p>
              <p className="mt-0.5 text-[rgba(245,243,236,0.7)]">
                Define <code className="font-mono">JEV_API_KEY</code> e{' '}
                <code className="font-mono">JEV_MODEL</code> no ficheiro <code className="font-mono">.env</code>{' '}
                e reinicia o servidor para ativar a geração.
              </p>
              {jevStatus?.model && (
                <p className="mt-1 text-[rgba(245,243,236,0.6)]">
                  Modelo: <strong className="text-[#F5F3EC]">{jevStatus.model}</strong>
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[rgba(245,243,236,0.65)]">
            <span className="inline-flex items-center gap-1.5 text-[#4FAE73] font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Configurado
            </span>
            <span>
              Modelo: <strong className="text-[#F5F3EC]">{jevStatus?.model || '—'}</strong>
            </span>
            <span>
              Provider: <strong className="text-[#F5F3EC]">{jevStatus?.provider || '—'}</strong>
            </span>
            {jevStatus?.endpoint && (
              <span className="truncate max-w-full">
                Endpoint: <code className="font-mono text-[11px]">{jevStatus.endpoint}</code>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] px-5 py-4 mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-[rgba(245,243,236,0.5)] mb-1.5">
              Escopo
            </span>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Escopo da geração JEV">
              {SCOPE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setScope(option.id)}
                  className={`cursor-pointer text-xs px-3.5 py-1.5 rounded-full border transition-all ${
                    scope === option.id
                      ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold'
                      : 'bg-transparent border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="jev-limit"
              className="block text-[10px] font-semibold uppercase tracking-wider text-[rgba(245,243,236,0.5)] mb-1.5"
            >
              Limite de fichas
            </label>
            <select
              id="jev-limit"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              className="cursor-pointer rounded border border-[rgba(245,243,236,0.2)] bg-[#081C13] px-2.5 py-1.5 text-xs text-[#F5F3EC] focus:border-[#E7B33E] focus:outline-none"
            >
              {[1, 2, 3, 4, 6, 8].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => {
              void onGenerate(scope, limit);
            }}
            disabled={!canGenerate}
            className="cursor-pointer inline-flex items-center gap-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] px-4 py-2.5 text-sm font-semibold text-[#3A2A06] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              configured
                ? 'Gerar fichas com o motor JEV'
                : 'Configura JEV_API_KEY e JEV_MODEL para gerar fichas'
            }
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4 fill-current" />
            )}
            <span>{generating ? 'A gerar com JEV...' : 'Gerar com JEV'}</span>
          </button>
        </div>
        <p className="mt-3 text-[11px] text-[rgba(245,243,236,0.45)]">
          A geração JEV cria fichas para o escopo {scopeLabels[scope].toLowerCase()} com um
          máximo de {limit} fichas por pedido.
        </p>
      </div>

      <div className="mb-6">
        <h2 className="font-display text-xl font-semibold text-[#F5F3EC] mb-3">
          Comparação de eficiência
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SummaryCard title="Motor principal" summary={summary.principal} accent="#4FAE73" />
          <SummaryCard title="Motor JEV" summary={summary.jev} accent="#E7B33E" />
        </div>
      </div>

      <EngineSlipsPanel
        slips={slips}
        timezone={timezone}
        title="Fichas JEV"
        subtitle="Fichas geradas pelo motor JEV, agrupadas por escopo e tier."
        emptyTitle="Ainda não há fichas JEV."
        emptyHint="Configura o motor e usa o botão Gerar com JEV para criar as primeiras fichas."
        historyTitle="Histórico JEV"
        onUpload={onUpload}
      />
    </div>
  );
};
