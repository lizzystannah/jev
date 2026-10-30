import React, { useMemo, useState } from 'react';
import { BetEngine, BetSlip, SlipTier } from '../types.js';
import { byMostRecent, engineOf, scopeLabel } from '../utils/slips.js';
import { formatDateTimeInTz } from '../utils/timezone.js';
import {
  Activity,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock,
  Filter,
  Hourglass,
  Layers,
  ListChecks,
  Percent,
  RotateCcw,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  XCircle,
} from 'lucide-react';

type EngineFilter = 'all' | BetEngine;
type ScopeFilter = 'all' | BetSlip['scope'];
type TierFilter = 'all' | SlipTier;
type StatusFilter = 'all' | BetSlip['status'];

interface Stats {
  total: number;
  pending: number;
  won: number;
  lost: number;
  expired: number;
  settled: number;
  winRate: number | null;
  profit: number;
  roi: number | null;
  avgOdds: number | null;
  avgProb: number | null;
  legs: number;
  legsWon: number;
  legRate: number | null;
}

const TIERS: SlipTier[] = ['segura', 'moderada', 'ousada', 'maluca', 'compostas'];
const SCOPES: Array<BetSlip['scope']> = ['dia', '2_3_dias', 'longo'];

const TIER_LABELS: Record<SlipTier, string> = {
  segura: 'Segura',
  moderada: 'Moderada',
  ousada: 'Ousada',
  maluca: 'Maluca',
  compostas: 'Compostas',
};

const TIER_COLORS: Record<SlipTier, string> = {
  segura: '#4FAE73',
  moderada: '#E7B33E',
  ousada: '#D1594B',
  maluca: '#C084FC',
  compostas: '#38BDF8',
};

const ENGINE_LABELS: Record<BetEngine, string> = {
  local: 'Principal',
  manual: 'Manual',
  jev: 'JEV',
  progression: 'Automação',
};

const ENGINE_OPTIONS: Array<{ id: EngineFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'local', label: 'Principal' },
  { id: 'manual', label: 'Manual' },
  { id: 'jev', label: 'JEV' },
  { id: 'progression', label: 'Automação' },
];

const SCOPE_OPTIONS: Array<{ id: ScopeFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'dia', label: 'Hoje' },
  { id: '2_3_dias', label: '2 a 3 dias' },
  { id: 'longo', label: 'Longo prazo' },
];

const TIER_OPTIONS: Array<{ id: TierFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  ...TIERS.map((tier) => ({ id: tier, label: TIER_LABELS[tier] })),
];

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'pendente', label: 'Pendentes' },
  { id: 'ganhou', label: 'Ganhas' },
  { id: 'perdeu', label: 'Perdidas' },
  { id: 'expirado', label: 'Vencidas' },
];

function statsFor(slips: BetSlip[]): Stats {
  let pending = 0;
  let won = 0;
  let lost = 0;
  let expired = 0;
  let oddsSum = 0;
  let oddsCount = 0;
  let probSum = 0;
  let probCount = 0;
  let legs = 0;
  let legsWon = 0;
  let returnedUnits = 0;

  for (const slip of slips) {
    if (slip.status === 'pendente') pending += 1;
    else if (slip.status === 'ganhou') won += 1;
    else if (slip.status === 'perdeu') lost += 1;
    else expired += 1;

    if (Number.isFinite(slip.combinedOdds) && slip.combinedOdds > 0) {
      oddsSum += slip.combinedOdds;
      oddsCount += 1;
      if (slip.status === 'ganhou') returnedUnits += slip.combinedOdds;
    }
    if (Number.isFinite(slip.combinedProb)) {
      probSum += slip.combinedProb;
      probCount += 1;
    }

    for (const leg of slip.legs || []) {
      if (leg.status !== 'resolved') continue;
      legs += 1;
      if (leg.result?.tipWon) legsWon += 1;
    }
  }

  const settled = won + lost;
  const profit = returnedUnits - settled;

  return {
    total: slips.length,
    pending,
    won,
    lost,
    expired,
    settled,
    winRate: settled > 0 ? (won / settled) * 100 : null,
    profit,
    roi: settled > 0 ? (profit / settled) * 100 : null,
    avgOdds: oddsCount > 0 ? oddsSum / oddsCount : null,
    avgProb: probCount > 0 ? probSum / probCount : null,
    legs,
    legsWon,
    legRate: legs > 0 ? (legsWon / legs) * 100 : null,
  };
}

interface LegBreakdownRow {
  label: string;
  total: number;
  won: number;
  rate: number | null;
}

function legBreakdown(
  slips: BetSlip[],
  labelOf: (leg: BetSlip['legs'][number]) => string
): LegBreakdownRow[] {
  const map = new Map<string, { total: number; won: number }>();
  for (const slip of slips) {
    for (const leg of slip.legs || []) {
      if (leg.status !== 'resolved') continue;
      const label = labelOf(leg) || 'Sem etiqueta';
      const current = map.get(label) || { total: 0, won: 0 };
      current.total += 1;
      if (leg.result?.tipWon) current.won += 1;
      map.set(label, current);
    }
  }
  return Array.from(map.entries())
    .map(([label, value]) => ({
      label,
      total: value.total,
      won: value.won,
      rate: value.total > 0 ? (value.won / value.total) * 100 : null,
    }))
    .sort((a, b) => b.total - a.total || (b.rate ?? 0) - (a.rate ?? 0))
    .slice(0, 8);
}

const pct = (value: number | null, digits = 1): string =>
  value == null ? '—' : `${value.toFixed(digits)}%`;

const signedPct = (value: number | null, digits = 1): string =>
  value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;

const units = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(2)}u`;

const oddsText = (value: number | null): string =>
  value == null ? '—' : `${value.toFixed(2)}x`;

const rateTone = (value: number | null): string =>
  value == null
    ? 'text-[rgba(245,243,236,0.45)]'
    : value >= 60
      ? 'text-[#4FAE73]'
      : value >= 40
        ? 'text-[#E7B33E]'
        : 'text-[#D1594B]';

const profitTone = (value: number): string =>
  value > 0 ? 'text-[#4FAE73]' : value < 0 ? 'text-[#D1594B]' : 'text-[rgba(245,243,236,0.6)]';

function statusMeta(status: BetSlip['status']) {
  switch (status) {
    case 'ganhou':
      return {
        label: 'Ganha',
        className: 'bg-[rgba(79,174,115,0.15)] text-[#4FAE73] border-[rgba(79,174,115,0.3)]',
        icon: <CheckCircle2 className="w-3 h-3" />,
      };
    case 'perdeu':
      return {
        label: 'Perdida',
        className: 'bg-[rgba(209,89,75,0.15)] text-[#D1594B] border-[rgba(209,89,75,0.3)]',
        icon: <XCircle className="w-3 h-3" />,
      };
    case 'expirado':
      return {
        label: 'Vencida',
        className:
          'bg-[rgba(245,243,236,0.07)] text-[rgba(245,243,236,0.65)] border-[rgba(245,243,236,0.18)]',
        icon: <Hourglass className="w-3 h-3" />,
      };
    default:
      return {
        label: 'Pendente',
        className: 'bg-[rgba(231,179,62,0.15)] text-[#E7B33E] border-[rgba(231,179,62,0.3)]',
        icon: <Activity className="w-3 h-3" />,
      };
  }
}

function slipProfit(slip: BetSlip): number | null {
  if (slip.status === 'ganhou') {
    return Number.isFinite(slip.combinedOdds) ? slip.combinedOdds - 1 : null;
  }
  if (slip.status === 'perdeu') return -1;
  return null;
}

interface FilterGroupProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
}

function FilterGroup<T extends string>({ label, value, options, onChange }: FilterGroupProps<T>) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider font-semibold text-[rgba(245,243,236,0.4)]">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              className={`cursor-pointer text-[11px] px-2.5 py-1 rounded border transition-colors ${
                active
                  ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC] font-semibold'
                  : 'bg-transparent border-[rgba(245,243,236,0.16)] text-[rgba(245,243,236,0.55)] hover:text-[#F5F3EC] hover:border-[rgba(245,243,236,0.35)]'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  valueClass?: string;
}

function KpiCard({ label, value, sub, icon, valueClass }: KpiCardProps) {
  return (
    <div className="bg-[#0E2A1C] p-4">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider font-semibold text-[rgba(245,243,236,0.4)]">
        <span>{label}</span>
        <span className="text-[#E7B33E]">{icon}</span>
      </div>
      <div className={`mt-2 font-display text-2xl sm:text-3xl leading-none ${valueClass || 'text-[#F5F3EC]'}`}>
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-[rgba(245,243,236,0.5)]">{sub}</div>
    </div>
  );
}

interface PerformanceRow {
  id: string;
  label: string;
  color?: string;
  stats: Stats;
  active: boolean;
  onClick: () => void;
}

function PerformanceTable({
  title,
  hint,
  rows,
  activeLabel,
}: {
  title: string;
  hint: string;
  rows: PerformanceRow[];
  activeLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C] overflow-hidden">
      <div className="px-4 py-3 border-b border-[rgba(245,243,236,0.1)] flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold text-[#F5F3EC]">{title}</h3>
          <p className="text-[11px] text-[rgba(245,243,236,0.45)] mt-0.5">{hint}</p>
        </div>
        {activeLabel && (
          <span className="shrink-0 text-[10px] px-2 py-1 rounded bg-[#173C27] border border-[#4FAE73]/30 text-[#4FAE73]">
            {activeLabel}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)] bg-[#081C13]/50">
              <th className="text-left font-semibold px-4 py-2">Categoria</th>
              <th className="text-right font-semibold px-2 py-2">Fichas</th>
              <th className="text-right font-semibold px-2 py-2">Resolvidas</th>
              <th className="text-right font-semibold px-2 py-2">V / P</th>
              <th className="text-right font-semibold px-2 py-2">Taxa</th>
              <th className="text-right font-semibold px-2 py-2">Lucro</th>
              <th className="text-right font-semibold px-4 py-2">ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={row.onClick}
                className={`cursor-pointer border-t border-[rgba(245,243,236,0.06)] transition-colors ${
                  row.active ? 'bg-[#173C27]' : 'hover:bg-[#173C27]/50'
                }`}
                title={`Filtrar por ${row.label}`}
              >
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2">
                    {row.color && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: row.color }}
                      />
                    )}
                    <span className={row.active ? 'text-[#F5F3EC] font-semibold' : 'text-[#F5F3EC]'}>
                      {row.label}
                    </span>
                    {row.active && <ChevronRight className="w-3 h-3 text-[#4FAE73]" />}
                  </span>
                </td>
                <td className="text-right px-2 py-2.5 text-[rgba(245,243,236,0.7)]">
                  {row.stats.total}
                  {row.stats.pending > 0 && (
                    <span className="ml-1 text-[10px] text-[#E7B33E]">({row.stats.pending})</span>
                  )}
                </td>
                <td className="text-right px-2 py-2.5 text-[rgba(245,243,236,0.7)]">
                  {row.stats.settled}
                </td>
                <td className="text-right px-2 py-2.5 whitespace-nowrap">
                  <span className="text-[#4FAE73]">{row.stats.won}</span>
                  <span className="text-[rgba(245,243,236,0.3)]"> / </span>
                  <span className="text-[#D1594B]">{row.stats.lost}</span>
                </td>
                <td className={`text-right px-2 py-2.5 font-semibold ${rateTone(row.stats.winRate)}`}>
                  {pct(row.stats.winRate)}
                </td>
                <td className={`text-right px-2 py-2.5 font-medium ${profitTone(row.stats.profit)}`}>
                  {row.stats.settled > 0 ? units(row.stats.profit) : '—'}
                </td>
                <td className={`text-right px-4 py-2.5 ${profitTone(row.stats.profit)}`}>
                  {row.stats.settled > 0 ? signedPct(row.stats.roi) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const DashboardTab: React.FC<{ slips: BetSlip[]; timezone: string }> = ({
  slips,
  timezone,
}) => {
  const [engine, setEngine] = useState<EngineFilter>('all');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [tier, setTier] = useState<TierFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const baseSlips = useMemo(
    () =>
      slips.filter(
        (slip) =>
          (engine === 'all' || engineOf(slip) === engine) &&
          (status === 'all' || slip.status === status)
      ),
    [slips, engine, status]
  );

  const focusedSlips = useMemo(
    () =>
      baseSlips.filter(
        (slip) =>
          (scope === 'all' || slip.scope === scope) &&
          (tier === 'all' || slip.tier === tier)
      ),
    [baseSlips, scope, tier]
  );

  const focusStats = useMemo(() => statsFor(focusedSlips), [focusedSlips]);

  const tierRows = useMemo<PerformanceRow[]>(
    () =>
      TIERS.map((rowTier) => {
        const rowSlips = baseSlips.filter(
          (slip) => slip.tier === rowTier && (scope === 'all' || slip.scope === scope)
        );
        return {
          id: rowTier,
          label: TIER_LABELS[rowTier],
          color: TIER_COLORS[rowTier],
          stats: statsFor(rowSlips),
          active: tier === rowTier,
          onClick: () => setTier((current) => (current === rowTier ? 'all' : rowTier)),
        };
      }),
    [baseSlips, scope, tier]
  );

  const scopeRows = useMemo<PerformanceRow[]>(
    () =>
      SCOPES.map((rowScope) => {
        const rowSlips = baseSlips.filter(
          (slip) => slip.scope === rowScope && (tier === 'all' || slip.tier === tier)
        );
        return {
          id: rowScope,
          label: scopeLabel(rowScope),
          stats: statsFor(rowSlips),
          active: scope === rowScope,
          onClick: () => setScope((current) => (current === rowScope ? 'all' : rowScope)),
        };
      }),
    [baseSlips, tier, scope]
  );

  const matrix = useMemo(
    () =>
      TIERS.map((rowTier) => ({
        tier: rowTier,
        cells: SCOPES.map((rowScope) => ({
          scope: rowScope,
          stats: statsFor(
            baseSlips.filter((slip) => slip.tier === rowTier && slip.scope === rowScope)
          ),
        })),
      })),
    [baseSlips]
  );

  const topCombos = useMemo(() => {
    const combos: Array<{
      tier: SlipTier;
      scope: BetSlip['scope'];
      stats: Stats;
    }> = [];
    for (const rowTier of TIERS) {
      for (const rowScope of SCOPES) {
        const stats = statsFor(
          baseSlips.filter((slip) => slip.tier === rowTier && slip.scope === rowScope)
        );
        if (stats.settled >= 3) combos.push({ tier: rowTier, scope: rowScope, stats });
      }
    }
    return combos
      .sort(
        (a, b) =>
          (b.stats.winRate ?? 0) - (a.stats.winRate ?? 0) ||
          b.stats.settled - a.stats.settled ||
          b.stats.profit - a.stats.profit
      )
      .slice(0, 5);
  }, [baseSlips]);

  const leagueRows = useMemo(
    () => legBreakdown(focusedSlips, (leg) => leg.league),
    [focusedSlips]
  );

  const marketRows = useMemo(
    () => legBreakdown(focusedSlips, (leg) => leg.tip?.label || leg.tip?.market || 'Sem etiqueta'),
    [focusedSlips]
  );

  const recentSlips = useMemo(
    () => [...focusedSlips].sort(byMostRecent).slice(0, 12),
    [focusedSlips]
  );

  const filtersActive = engine !== 'all' || scope !== 'all' || tier !== 'all' || status !== 'all';
  const activeFilterLabel = [
    engine !== 'all' ? ENGINE_LABELS[engine] : null,
    scope !== 'all' ? scopeLabel(scope) : null,
    tier !== 'all' ? TIER_LABELS[tier] : null,
    status !== 'all' ? STATUS_OPTIONS.find((option) => option.id === status)?.label : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const resetFilters = () => {
    setEngine('all');
    setScope('all');
    setTier('all');
    setStatus('all');
  };

  const selectCell = (cellTier: SlipTier, cellScope: BetSlip['scope']) => {
    const same = tier === cellTier && scope === cellScope;
    setTier(same ? 'all' : cellTier);
    setScope(same ? 'all' : cellScope);
  };

  return (
    <main className="flex-1 max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-5">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[#4FAE73]">
            <BarChart3 className="w-3.5 h-3.5 text-[#E7B33E]" />
            Radiografia de resultados
          </div>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl font-semibold text-[#F5F3EC]">
            Dashboard de desempenho
          </h2>
          <p className="mt-1 text-xs text-[rgba(245,243,236,0.5)] max-w-2xl">
            Cruza motor, horizonte, tier e estado. A taxa de acerto usa apenas fichas resolvidas
            (ganhas + perdidas); pendentes e vencidas ficam de fora. Lucro e ROI assumem 1 unidade
            por ficha.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)]">
            Foco atual
          </div>
          <div className="text-sm font-semibold text-[#E7B33E]">
            {focusedSlips.length} ficha(s)
          </div>
          {activeFilterLabel && (
            <div className="text-[10px] text-[rgba(245,243,236,0.5)] mt-0.5">{activeFilterLabel}</div>
          )}
        </div>
      </div>

      <section className="rounded-lg border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C] p-4 mb-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#F5F3EC]">
            <Filter className="w-3.5 h-3.5 text-[#E7B33E]" />
            Filtros
          </div>
          <button
            type="button"
            onClick={resetFilters}
            disabled={!filtersActive}
            className="cursor-pointer inline-flex items-center gap-1 text-[11px] font-medium text-[#E7B33E] hover:text-[#F0C869] disabled:opacity-30"
          >
            <RotateCcw className="w-3 h-3" />
            Limpar
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <FilterGroup label="Motor" value={engine} options={ENGINE_OPTIONS} onChange={setEngine} />
          <FilterGroup label="Horizonte" value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
          <FilterGroup label="Tier" value={tier} options={TIER_OPTIONS} onChange={setTier} />
          <FilterGroup label="Estado" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        </div>
      </section>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-px bg-[rgba(245,243,236,0.14)] border border-[rgba(245,243,236,0.14)] rounded overflow-hidden mb-5">
        <KpiCard
          label="Fichas"
          value={String(focusStats.total)}
          sub={`${focusStats.pending} pendentes · ${focusStats.expired} vencidas`}
          icon={<Layers className="w-3.5 h-3.5" />}
        />
        <KpiCard
          label="Resolvidas"
          value={String(focusStats.settled)}
          sub={`${focusStats.won} ganhas · ${focusStats.lost} perdidas`}
          icon={<ListChecks className="w-3.5 h-3.5" />}
        />
        <KpiCard
          label="Taxa de acerto"
          value={pct(focusStats.winRate)}
          sub={focusStats.settled > 0 ? `${focusStats.won}/${focusStats.settled}` : 'sem resolvidas'}
          icon={<Target className="w-3.5 h-3.5" />}
          valueClass={rateTone(focusStats.winRate)}
        />
        <KpiCard
          label="Lucro"
          value={focusStats.settled > 0 ? units(focusStats.profit) : '—'}
          sub={`ROI ${focusStats.settled > 0 ? signedPct(focusStats.roi) : '—'}`}
          icon={focusStats.profit >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          valueClass={profitTone(focusStats.profit)}
        />
        <KpiCard
          label="Odd média"
          value={oddsText(focusStats.avgOdds)}
          sub={`Prob. média ${pct(focusStats.avgProb, 0)}`}
          icon={<Percent className="w-3.5 h-3.5" />}
        />
        <KpiCard
          label="Pernas"
          value={pct(focusStats.legRate)}
          sub={`${focusStats.legsWon}/${focusStats.legs} acertos`}
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          valueClass={rateTone(focusStats.legRate)}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <PerformanceTable
          title="Por tier"
          hint={
            scope === 'all'
              ? 'Compara todos os horizontes. Clica numa linha para focar o tier.'
              : `Tiers dentro de ${scopeLabel(scope)}. Clica para focar.`
          }
          rows={tierRows}
          activeLabel={tier !== 'all' ? TIER_LABELS[tier] : undefined}
        />
        <PerformanceTable
          title="Por horizonte"
          hint={
            tier === 'all'
              ? 'Compara hoje, 2 a 3 dias e longo prazo. Clica para focar.'
              : `Horizontes dentro de ${TIER_LABELS[tier]}. Clica para focar.`
          }
          rows={scopeRows}
          activeLabel={scope !== 'all' ? scopeLabel(scope) : undefined}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 mb-4">
        <div className="rounded-lg border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C] overflow-hidden">
          <div className="px-4 py-3 border-b border-[rgba(245,243,236,0.1)]">
            <h3 className="font-display text-base font-semibold text-[#F5F3EC] flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-[#E7B33E]" />
              Matriz tier × horizonte
            </h3>
            <p className="text-[11px] text-[rgba(245,243,236,0.45)] mt-0.5">
              Cada célula mostra taxa de acerto, registo e lucro. Clica para cruzar os dois filtros.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[620px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)] bg-[#081C13]/50">
                  <th className="text-left font-semibold px-4 py-2">Tier</th>
                  {SCOPES.map((rowScope) => (
                    <th key={rowScope} className="text-center font-semibold px-2 py-2">
                      {scopeLabel(rowScope)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((row) => (
                  <tr key={row.tier} className="border-t border-[rgba(245,243,236,0.06)]">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: TIER_COLORS[row.tier] }}
                        />
                        <span className="text-[#F5F3EC] font-medium">{TIER_LABELS[row.tier]}</span>
                      </span>
                    </td>
                    {row.cells.map((cell) => {
                      const active = tier === row.tier && scope === cell.scope;
                      return (
                        <td key={cell.scope} className="p-1.5">
                          <button
                            type="button"
                            onClick={() => selectCell(row.tier, cell.scope)}
                            className={`w-full h-full rounded border px-2 py-2 text-center transition-colors cursor-pointer ${
                              active
                                ? 'bg-[#20502F] border-[#4FAE73]'
                                : 'bg-[#081C13]/40 border-[rgba(245,243,236,0.08)] hover:bg-[#173C27] hover:border-[rgba(245,243,236,0.22)]'
                            }`}
                            title={`${TIER_LABELS[row.tier]} · ${scopeLabel(cell.scope)}`}
                          >
                            <div className={`font-display text-base font-semibold ${rateTone(cell.stats.winRate)}`}>
                              {pct(cell.stats.winRate, 0)}
                            </div>
                            <div className="text-[10px] text-[rgba(245,243,236,0.55)] mt-0.5">
                              {cell.stats.won}/{cell.stats.settled} · {cell.stats.pending} pend.
                            </div>
                            <div className={`text-[10px] mt-0.5 font-medium ${profitTone(cell.stats.profit)}`}>
                              {cell.stats.settled > 0 ? units(cell.stats.profit) : 'sem amostra'}
                            </div>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-[rgba(245,243,236,0.08)] text-[10px] text-[rgba(245,243,236,0.4)]">
            Amostras pequenas enganam: confirma o número de resolvidas antes de tirar conclusões.
          </div>
        </div>

        <div className="rounded-lg border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C] overflow-hidden">
          <div className="px-4 py-3 border-b border-[rgba(245,243,236,0.1)]">
            <h3 className="font-display text-base font-semibold text-[#F5F3EC] flex items-center gap-2">
              <Trophy className="w-4 h-4 text-[#E7B33E]" />
              Melhores combinações
            </h3>
            <p className="text-[11px] text-[rgba(245,243,236,0.45)] mt-0.5">
              Só combinações com 3+ fichas resolvidas.
            </p>
          </div>
          {topCombos.length > 0 ? (
            <ol className="divide-y divide-[rgba(245,243,236,0.06)]">
              {topCombos.map((combo, index) => (
                <li key={`${combo.tier}-${combo.scope}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setTier(combo.tier);
                      setScope(combo.scope);
                    }}
                    className="w-full text-left px-4 py-2.5 hover:bg-[#173C27]/60 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-[#F5F3EC]">
                        <span className="text-[#E7B33E] font-mono mr-1.5">{index + 1}.</span>
                        {TIER_LABELS[combo.tier]} · {scopeLabel(combo.scope)}
                      </span>
                      <span className={`text-sm font-semibold ${rateTone(combo.stats.winRate)}`}>
                        {pct(combo.stats.winRate, 0)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-[rgba(245,243,236,0.5)]">
                      <span>
                        {combo.stats.won}/{combo.stats.settled} resolvidas
                      </span>
                      <span className={profitTone(combo.stats.profit)}>{units(combo.stats.profit)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="px-4 py-6 text-center text-[11px] text-[rgba(245,243,236,0.45)]">
              Ainda sem combinações com pelo menos 3 fichas resolvidas.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <LegBreakdownTable
          title="Precisão por liga"
          hint="Pernas resolvidas nas fichas do foco atual."
          rows={leagueRows}
          icon={<Target className="w-4 h-4 text-[#E7B33E]" />}
        />
        <LegBreakdownTable
          title="Precisão por mercado"
          hint="Mercados reais das pernas resolvidas no foco atual."
          rows={marketRows}
          icon={<Percent className="w-4 h-4 text-[#E7B33E]" />}
        />
      </div>

      <div className="rounded-lg border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C] overflow-hidden">
        <div className="px-4 py-3 border-b border-[rgba(245,243,236,0.1)] flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold text-[#F5F3EC] flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#E7B33E]" />
              Fichas recentes do foco
            </h3>
            <p className="text-[11px] text-[rgba(245,243,236,0.45)] mt-0.5">
              Últimas 12 fichas que correspondem aos filtros.
            </p>
          </div>
          {focusedSlips.length > recentSlips.length && (
            <span className="text-[10px] text-[rgba(245,243,236,0.45)] shrink-0">
              {recentSlips.length} de {focusedSlips.length}
            </span>
          )}
        </div>
        {recentSlips.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[760px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)] bg-[#081C13]/50">
                  <th className="text-left font-semibold px-4 py-2">Estado</th>
                  <th className="text-left font-semibold px-2 py-2">Ficha</th>
                  <th className="text-left font-semibold px-2 py-2">Tier / horizonte</th>
                  <th className="text-left font-semibold px-2 py-2">Motor</th>
                  <th className="text-right font-semibold px-2 py-2">Odd</th>
                  <th className="text-right font-semibold px-2 py-2">Lucro</th>
                  <th className="text-right font-semibold px-4 py-2">Fechada em</th>
                </tr>
              </thead>
              <tbody>
                {recentSlips.map((slip) => {
                  const meta = statusMeta(slip.status);
                  const profit = slipProfit(slip);
                  return (
                    <tr
                      key={slip.id}
                      className="border-t border-[rgba(245,243,236,0.06)] hover:bg-[#173C27]/40"
                    >
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${meta.className}`}
                        >
                          {meta.icon}
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="text-[#F5F3EC] font-medium truncate max-w-[220px]">
                          {slip.customTitle || `Ficha ${slip.id}`}
                        </div>
                        <div className="text-[10px] text-[rgba(245,243,236,0.4)]">{slip.id}</div>
                      </td>
                      <td className="px-2 py-2.5">
                        <span
                          className="text-[10.5px] font-semibold uppercase tracking-wider"
                          style={{ color: TIER_COLORS[slip.tier] }}
                        >
                          {TIER_LABELS[slip.tier]}
                        </span>
                        <span className="text-[10px] text-[rgba(245,243,236,0.45)]">
                          {' '}
                          · {scopeLabel(slip.scope)}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-[11px] text-[rgba(245,243,236,0.6)]">
                        {ENGINE_LABELS[engineOf(slip)]}
                      </td>
                      <td className="text-right px-2 py-2.5 text-[rgba(245,243,236,0.7)]">
                        {oddsText(slip.combinedOdds)}
                      </td>
                      <td
                        className={`text-right px-2 py-2.5 font-medium ${
                          profit == null ? 'text-[rgba(245,243,236,0.35)]' : profitTone(profit)
                        }`}
                      >
                        {profit == null ? '—' : units(profit)}
                      </td>
                      <td className="text-right px-4 py-2.5 text-[10.5px] text-[rgba(245,243,236,0.5)]">
                        {slip.resolvedAt
                          ? formatDateTimeInTz(slip.resolvedAt, timezone)
                          : formatDateTimeInTz(slip.createdAt, timezone)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-xs text-[rgba(245,243,236,0.5)]">
            Sem fichas para os filtros atuais.
          </div>
        )}
      </div>
    </main>
  );
};

function LegBreakdownTable({
  title,
  hint,
  rows,
  icon,
}: {
  title: string;
  hint: string;
  rows: LegBreakdownRow[];
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C] overflow-hidden">
      <div className="px-4 py-3 border-b border-[rgba(245,243,236,0.1)]">
        <h3 className="font-display text-base font-semibold text-[#F5F3EC] flex items-center gap-2">
          {icon}
          {title}
        </h3>
        <p className="text-[11px] text-[rgba(245,243,236,0.45)] mt-0.5">{hint}</p>
      </div>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[420px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.4)] bg-[#081C13]/50">
                <th className="text-left font-semibold px-4 py-2">Nome</th>
                <th className="text-right font-semibold px-2 py-2">Pernas</th>
                <th className="text-right font-semibold px-2 py-2">Acertos</th>
                <th className="text-right font-semibold px-4 py-2">Taxa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-[rgba(245,243,236,0.06)]">
                  <td className="px-4 py-2 text-[#F5F3EC] max-w-[220px] truncate" title={row.label}>
                    {row.label}
                  </td>
                  <td className="text-right px-2 py-2 text-[rgba(245,243,236,0.6)]">{row.total}</td>
                  <td className="text-right px-2 py-2 text-[rgba(245,243,236,0.6)]">{row.won}</td>
                  <td className={`text-right px-4 py-2 font-semibold ${rateTone(row.rate)}`}>
                    <span className="inline-flex items-center gap-1.5 justify-end">
                      <span>{pct(row.rate, 0)}</span>
                      <span className="hidden sm:inline-block w-10 h-1 rounded bg-[rgba(245,243,236,0.12)] overflow-hidden">
                        <span
                          className="block h-full rounded"
                          style={{
                            width: `${Math.max(0, Math.min(100, row.rate ?? 0))}%`,
                            backgroundColor:
                              (row.rate ?? 0) >= 60
                                ? '#4FAE73'
                                : (row.rate ?? 0) >= 40
                                  ? '#E7B33E'
                                  : '#D1594B',
                          }}
                        />
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-[11px] text-[rgba(245,243,236,0.45)]">
          Sem pernas resolvidas para os filtros atuais.
        </div>
      )}
    </div>
  );
}
