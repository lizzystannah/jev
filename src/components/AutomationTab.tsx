import React, { useEffect, useMemo, useState } from 'react';
import {
  CreateProgressionInput,
  PremierBetStatus,
  Progression,
  ProgressionMode,
  ProgressionRunStatus,
  SlipScope,
  SlipTier,
} from '../types.js';
import * as api from '../api.js';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

interface AutomationTabProps {
  progressions: Progression[];
  onRefresh: () => Promise<void> | void;
  onToast: (message: string) => void;
}

type AutomationTier = Exclude<SlipTier, 'maluca'>;
type AutomationScope = Exclude<SlipScope, 'historico'>;

const ENGINE_LABELS: Record<'local' | 'jev', string> = {
  local: 'Principal',
  jev: 'JEV',
};

const TIER_LABELS: Record<AutomationTier, string> = {
  segura: 'Segura',
  moderada: 'Moderada',
  ousada: 'Ousada',
};

const SCOPE_LABELS: Record<AutomationScope, string> = {
  dia: 'Hoje',
  '2_3_dias': '2 a 3 dias',
  longo: 'Longo prazo',
};

const MODE_LABELS: Record<ProgressionMode, string> = {
  fixo: 'Fixo',
  total: 'Reinvestimento total',
  metade: 'Metade do lucro',
  soros: 'Soros',
};

const RUN_LABELS: Record<ProgressionRunStatus, string> = {
  pendente: 'Em andamento',
  ganhou: 'Ganha',
  perdeu: 'Perdida',
  expirado: 'Vencida',
  falhou: 'Falhou',
};

const RUN_CLASSES: Record<ProgressionRunStatus, string> = {
  pendente: 'bg-[#E7B33E]/15 text-[#E7B33E] border-[#E7B33E]/40',
  ganhou: 'bg-[#4FAE73]/15 text-[#4FAE73] border-[#4FAE73]/40',
  perdeu: 'bg-[#D1594B]/15 text-[#D1594B] border-[#D1594B]/40',
  expirado: 'bg-[rgba(245,243,236,0.08)] text-[rgba(245,243,236,0.7)] border-[rgba(245,243,236,0.2)]',
  falhou: 'bg-[#D1594B]/15 text-[#D1594B] border-[#D1594B]/40',
};

const kz = (value: number): string =>
  new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'AOA',
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);

const dateTime = (ts: number): string =>
  new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));

const profitClass = (value: number): string =>
  value > 0 ? 'text-[#4FAE73]' : value < 0 ? 'text-[#D1594B]' : 'text-[#F5F3EC]';

export const AutomationTab: React.FC<AutomationTabProps> = ({
  progressions,
  onRefresh,
  onToast,
}) => {
  const [premierBet, setPremierBet] = useState<PremierBetStatus | null>(null);
  const [showForm, setShowForm] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [engine, setEngine] = useState<'local' | 'jev'>('local');
  const [tier, setTier] = useState<AutomationTier>('segura');
  const [scope, setScope] = useState<AutomationScope>('dia');
  const [mode, setMode] = useState<ProgressionMode>('fixo');
  const [baseStake, setBaseStake] = useState('100');
  const [reinvestPct, setReinvestPct] = useState('50');
  const [maxLevel, setMaxLevel] = useState('10');
  const [oddsMin, setOddsMin] = useState('4.00');
  const [oddsMax, setOddsMax] = useState('4.99');

  useEffect(() => {
    api
      .fetchPremierBetStatus()
      .then(setPremierBet)
      .catch(() => setPremierBet(null));
  }, []);

  const activeCount = useMemo(
    () => progressions.filter((p) => p.status === 'ativa').length,
    [progressions]
  );

  const resetForm = () => {
    setName('');
    setEngine('local');
    setTier('segura');
    setScope('dia');
    setMode('fixo');
    setBaseStake('100');
    setReinvestPct('50');
    setMaxLevel('10');
    setOddsMin('4.00');
    setOddsMax('4.99');
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const stake = Number(baseStake);
    const level = Number(maxLevel);
    if (!Number.isFinite(stake) || stake <= 0) {
      onToast('Indique um valor base válido.');
      return;
    }
    if (!Number.isFinite(level) || level < 1) {
      onToast('Indique o nível máximo da progressão.');
      return;
    }

    const input: CreateProgressionInput = {
      name: name.trim() || undefined,
      engine,
      tier,
      scope,
      mode,
      baseStake: stake,
      reinvestPct: mode === 'soros' ? Number(reinvestPct) : undefined,
      maxLevel: level,
      targetOddsMin: Number(oddsMin) || 4,
      targetOddsMax: Number(oddsMax) || 4.99,
    };

    try {
      setSubmitting(true);
      const created = await api.createProgression(input);
      onToast(`${created.id} criada. Clique em Play para começar a apostar.`);
      resetForm();
      await onRefresh();
    } catch (err: any) {
      onToast(err?.message || 'Falha ao criar a progressão.');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePlay = async (progression: Progression) => {
    if (busyId) return;
    if (progression.status === 'erro' && progression.lastError) {
      const confirmar = window.confirm(
        `${progression.id} está em erro:\n\n${progression.lastError}\n\n` +
          'Confirma que verificou as apostas abertas na Premier Bet e quer retomar a automação?'
      );
      if (!confirmar) return;
    }
    try {
      setBusyId(progression.id);
      onToast(`${progression.id}: automação ativa. A primeira ficha está a ser gerada.`);
      await api.playProgression(progression.id);
      await onRefresh();
    } catch (err: any) {
      onToast(err?.message || 'Falha ao iniciar a progressão.');
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (progression: Progression) => {
    if (busyId) return;
    try {
      setBusyId(progression.id);
      await api.stopProgression(progression.id);
      onToast(`${progression.id} pausada. A aposta em curso continua válida.`);
      await onRefresh();
    } catch (err: any) {
      onToast(err?.message || 'Falha ao parar a progressão.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (progression: Progression) => {
    if (busyId) return;
    const aviso =
      `Excluir a progressão ${progression.id}? ` +
      'A configuração e o histórico local são removidos. Apostas já colocadas na Premier Bet NÃO são canceladas.';
    if (!window.confirm(aviso)) return;
    try {
      setBusyId(progression.id);
      await api.deleteProgression(progression.id);
      onToast(`${progression.id} excluída.`);
      await onRefresh();
    } catch (err: any) {
      onToast(err?.message || 'Falha ao excluir a progressão.');
    } finally {
      setBusyId(null);
    }
  };

  const premierBetWarning =
    premierBet && (!premierBet.configured || !premierBet.scriptExists || premierBet.dryRun);

  return (
    <main className="flex-1 max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-9">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-[#E7B33E]" />
            <h2 className="font-display text-2xl font-semibold tracking-wide text-[#F5F3EC]">
              Automação de progressões
            </h2>
            {activeCount > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#4FAE73]/15 text-[#4FAE73] border border-[#4FAE73]/40 font-semibold">
                {activeCount} ativa(s)
              </span>
            )}
          </div>
          <p className="text-xs text-[rgba(245,243,236,0.55)] mt-1 max-w-2xl">
            Cada nível gera uma ficha com odd total entre{' '}
            <strong className="text-[#F5F3EC]">4.00x e 4.99x</strong> e coloca-a
            automaticamente na Premier Bet com dinheiro real. Ao perder, o ciclo volta ao
            nível 1. Ao chegar ao nível máximo, recomeça no nível 1 e continua até clicar
            Stop.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="cursor-pointer inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded border border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.75)] hover:text-[#F5F3EC] hover:border-[#E7B33E]/50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Atualizar</span>
          </button>
          <button
            type="button"
            onClick={() => setShowForm((value) => !value)}
            className="cursor-pointer inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06]"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{showForm ? 'Ocultar configuração' : 'Nova progressão'}</span>
          </button>
        </div>
      </div>

      {premierBetWarning && (
        <div className="mb-5 flex items-start gap-2 rounded border border-[#E7B33E]/40 bg-[#E7B33E]/10 px-4 py-3 text-xs text-[#F0C869]">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {!premierBet?.configured
              ? 'Premier Bet sem credenciais configuradas (PREMIERBET_LOGIN / PREMIERBET_PASSWORD). O Play não conseguirá colocar apostas reais.'
              : !premierBet?.scriptExists
              ? 'Bridge da Premier Bet não encontrado no servidor (Scraping/premierbet_book.py).'
              : 'A execução está em modo de teste (PREMIERBET_DRY_RUN). Desative para apostas reais.'}
          </span>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] p-5 mb-7"
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-[#F5F3EC]">Criar progressão</h3>
              <p className="text-[11px] text-[rgba(245,243,236,0.5)]">
                A automação começa pausada. Depois de criar, clique em Play.
              </p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.45)]">
              {activeCount} / {progressions.length} ativas
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="flex flex-col gap-1.5 md:col-span-3">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Nome (opcional)
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ex.: Soros de hoje"
                className="w-full rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Motor
              </span>
              <select
                value={engine}
                onChange={(event) => setEngine(event.target.value as 'local' | 'jev')}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              >
                <option value="local">Principal</option>
                <option value="jev">JEV</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Tier
              </span>
              <select
                value={tier}
                onChange={(event) => setTier(event.target.value as AutomationTier)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              >
                <option value="segura">Segura</option>
                <option value="moderada">Moderada</option>
                <option value="ousada">Ousada</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Horizonte
              </span>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as AutomationScope)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              >
                <option value="dia">Hoje</option>
                <option value="2_3_dias">2 a 3 dias</option>
                <option value="longo">Longo prazo</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Modo de banca
              </span>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as ProgressionMode)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              >
                <option value="fixo">Fixo (valor base sempre)</option>
                <option value="total">Reinvestimento total (100% do lucro)</option>
                <option value="metade">Metade do lucro (50%)</option>
                <option value="soros">Soros (percentagem personalizada)</option>
              </select>
            </label>

            {mode === 'soros' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                  % do lucro a reinvestir
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={reinvestPct}
                  onChange={(event) => setReinvestPct(event.target.value)}
                  className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
                />
              </label>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Valor base (Kz)
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={baseStake}
                onChange={(event) => setBaseStake(event.target.value)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Nível máximo
              </span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={maxLevel}
                onChange={(event) => setMaxLevel(event.target.value)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Odds mínima
              </span>
              <input
                type="number"
                min={4}
                max={4.99}
                step={0.01}
                value={oddsMin}
                onChange={(event) => setOddsMin(event.target.value)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold text-[rgba(245,243,236,0.6)]">
                Odds máxima
              </span>
              <input
                type="number"
                min={4.01}
                max={4.99}
                step={0.01}
                value={oddsMax}
                onChange={(event) => setOddsMax(event.target.value)}
                className="rounded border border-[rgba(245,243,236,0.18)] bg-[#081C13] px-3 py-2 text-sm text-[#F5F3EC] outline-none focus:border-[#E7B33E]/60"
              />
            </label>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-5 pt-4 border-t border-[rgba(245,243,236,0.1)]">
            <p className="text-[11px] text-[rgba(245,243,236,0.45)] max-w-2xl">
              {mode === 'fixo'
                ? 'Fixo: todas as fichas usam o valor base.'
                : mode === 'total'
                ? 'Reinvestimento total: próxima ficha = base + 100% do lucro anterior.'
                : mode === 'metade'
                ? 'Metade: próxima ficha = base + 50% do lucro anterior.'
                : `Soros: próxima ficha = base + ${reinvestPct || 0}% do lucro anterior.`}{' '}
              Ao perder, volta sempre ao nível 1 com o valor base.
            </p>
            <button
              type="submit"
              disabled={submitting}
              className="cursor-pointer inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-4 py-2 rounded bg-[#4FAE73] hover:bg-[#5FBE83] text-[#081C13] disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>{submitting ? 'A criar...' : 'Criar progressão'}</span>
            </button>
          </div>
        </form>
      )}

      {progressions.length === 0 ? (
        <div className="border border-dashed border-[rgba(245,243,236,0.22)] rounded-lg p-10 text-center">
          <Bot className="w-8 h-8 text-[rgba(245,243,236,0.3)] mx-auto mb-3" />
          <p className="text-sm font-medium text-[#F5F3EC]">Nenhuma progressão criada.</p>
          <p className="text-xs text-[rgba(245,243,236,0.5)] mt-1 max-w-md mx-auto">
            Crie a primeira configuração acima, escolha o motor, o tier, o horizonte e o
            modo de banca. Depois clique em Play para a automação começar.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {progressions.map((progression) => {
            const busy = busyId === progression.id;
            const isActive = progression.status === 'ativa';
            const latest = progression.runs[0];
            const recentRuns = progression.runs.slice(0, 8);

            return (
              <section
                key={progression.id}
                className="rounded-lg border border-[rgba(245,243,236,0.14)] bg-[#0E2A1C] overflow-hidden"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-[rgba(245,243,236,0.1)]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-[#F5F3EC] truncate">
                        {progression.name}
                      </h3>
                      <span className="text-[10px] font-mono text-[rgba(245,243,236,0.45)]">
                        {progression.id}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
                          isActive
                            ? 'bg-[#4FAE73]/15 text-[#4FAE73] border-[#4FAE73]/40'
                            : progression.status === 'erro'
                            ? 'bg-[#D1594B]/15 text-[#D1594B] border-[#D1594B]/40'
                            : 'bg-[rgba(245,243,236,0.08)] text-[rgba(245,243,236,0.65)] border-[rgba(245,243,236,0.2)]'
                        }`}
                      >
                        {isActive ? 'ATIVA' : progression.status === 'erro' ? 'ERRO' : 'PAUSADA'}
                      </span>
                    </div>
                    <p className="text-[11px] text-[rgba(245,243,236,0.5)] mt-1">
                      {ENGINE_LABELS[progression.engine]} · {TIER_LABELS[progression.tier]} ·{' '}
                      {SCOPE_LABELS[progression.scope]} · {MODE_LABELS[progression.mode]}
                      {progression.mode === 'soros' ? ` (${progression.reinvestPct}%)` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {isActive ? (
                      <button
                        type="button"
                        onClick={() => void handleStop(progression)}
                        disabled={busy}
                        className="cursor-pointer inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded border border-[#D1594B]/50 text-[#D1594B] hover:bg-[#D1594B]/10 disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Square className="w-3 h-3" />
                        )}
                        Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handlePlay(progression)}
                        disabled={busy}
                        className="cursor-pointer inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded bg-[#4FAE73] hover:bg-[#5FBE83] text-[#081C13] disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Play className="w-3 h-3 fill-current" />
                        )}
                        {busy ? 'A colocar...' : 'Play'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDelete(progression)}
                      disabled={busy}
                      className="cursor-pointer inline-flex items-center justify-center w-7 h-7 rounded border border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.5)] hover:text-[#D1594B] hover:border-[#D1594B]/40 disabled:opacity-50"
                      title="Excluir progressão"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[rgba(245,243,236,0.08)]">
                  <div className="bg-[#0E2A1C] px-4 py-3">
                    <span className="block text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.45)]">
                      Nível
                    </span>
                    <span className="text-sm font-semibold text-[#F5F3EC]">
                      {progression.currentLevel} / {progression.maxLevel}
                    </span>
                    <span className="block text-[10px] text-[rgba(245,243,236,0.4)]">
                      {progression.cycles} ciclo(s)
                    </span>
                  </div>
                  <div className="bg-[#0E2A1C] px-4 py-3">
                    <span className="block text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.45)]">
                      Próxima ficha
                    </span>
                    <span className="text-sm font-semibold text-[#E7B33E]">
                      {kz(progression.currentStake)}
                    </span>
                    <span className="block text-[10px] text-[rgba(245,243,236,0.4)]">
                      base {kz(progression.baseStake)}
                    </span>
                  </div>
                  <div className="bg-[#0E2A1C] px-4 py-3">
                    <span className="block text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.45)]">
                      Último resultado
                    </span>
                    <span className={`text-sm font-semibold ${profitClass(progression.lastProfit)}`}>
                      {progression.lastProfit > 0 ? '+' : ''}
                      {kz(progression.lastProfit)}
                    </span>
                    <span className="block text-[10px] text-[rgba(245,243,236,0.4)]">
                      {latest ? RUN_LABELS[latest.status] : 'sem fichas'}
                    </span>
                  </div>
                  <div className="bg-[#0E2A1C] px-4 py-3">
                    <span className="block text-[10px] uppercase tracking-wider text-[rgba(245,243,236,0.45)]">
                      Lucro total
                    </span>
                    <span
                      className={`text-sm font-semibold flex items-center gap-1 ${profitClass(
                        progression.totalProfit
                      )}`}
                    >
                      {progression.totalProfit > 0 ? (
                        <TrendingUp className="w-3.5 h-3.5" />
                      ) : progression.totalProfit < 0 ? (
                        <TrendingDown className="w-3.5 h-3.5" />
                      ) : null}
                      {progression.totalProfit > 0 ? '+' : ''}
                      {kz(progression.totalProfit)}
                    </span>
                    <span className="block text-[10px] text-[rgba(245,243,236,0.4)]">
                      odds {progression.targetOddsMin.toFixed(2)}–{progression.targetOddsMax.toFixed(2)}x
                    </span>
                  </div>
                </div>

                {progression.lastError && (
                  <div className="flex items-start gap-2 px-5 py-3 border-t border-[rgba(245,243,236,0.08)] bg-[#D1594B]/10 text-[11px] text-[#E79A90]">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{progression.lastError}</span>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[11px] uppercase tracking-wider font-semibold text-[rgba(245,243,236,0.55)]">
                      Histórico de níveis
                    </h4>
                    <span className="text-[10px] text-[rgba(245,243,236,0.4)]">
                      {progression.runs.length} ficha(s)
                    </span>
                  </div>

                  {recentRuns.length === 0 ? (
                    <p className="text-[11px] text-[rgba(245,243,236,0.45)] py-2">
                      Ainda não há fichas. Clique em Play para gerar o nível 1.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-left text-[rgba(245,243,236,0.45)] border-b border-[rgba(245,243,236,0.1)]">
                            <th className="py-1.5 pr-2 font-medium">N</th>
                            <th className="py-1.5 pr-2 font-medium">Ficha</th>
                            <th className="py-1.5 pr-2 font-medium">ID Premier Bet</th>
                            <th className="py-1.5 pr-2 font-medium text-right">Valor</th>
                            <th className="py-1.5 pr-2 font-medium text-right">Odds</th>
                            <th className="py-1.5 pr-2 font-medium text-right">Lucro</th>
                            <th className="py-1.5 font-medium">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recentRuns.map((run) => (
                            <tr
                              key={`${run.slipId}-${run.level}-${run.createdAt}`}
                              className="border-b border-[rgba(245,243,236,0.06)] last:border-0"
                            >
                              <td className="py-1.5 pr-2 text-[#F5F3EC]">{run.level}</td>
                              <td className="py-1.5 pr-2">
                                <span className="font-mono text-[10px] text-[rgba(245,243,236,0.7)]">
                                  {run.slipId}
                                </span>
                                <span className="block text-[9px] text-[rgba(245,243,236,0.4)]">
                                  {dateTime(run.createdAt)}
                                </span>
                              </td>
                              <td className="py-1.5 pr-2">
                                {run.betId ? (
                                  <span className="font-mono text-[10px] text-[#4FAE73]">
                                    {run.betId}
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-[rgba(245,243,236,0.35)]">—</span>
                                )}
                              </td>
                              <td className="py-1.5 pr-2 text-right text-[rgba(245,243,236,0.8)]">
                                {kz(run.stake)}
                              </td>
                              <td className="py-1.5 pr-2 text-right text-[rgba(245,243,236,0.8)]">
                                {run.odds.toFixed(2)}x
                              </td>
                              <td
                                className={`py-1.5 pr-2 text-right font-semibold ${
                                  run.profit == null
                                    ? 'text-[rgba(245,243,236,0.35)]'
                                    : profitClass(run.profit)
                                }`}
                              >
                                {run.profit == null
                                  ? '—'
                                  : `${run.profit > 0 ? '+' : ''}${kz(run.profit)}`}
                              </td>
                              <td className="py-1.5">
                                <span
                                  className={`inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded border ${RUN_CLASSES[run.status]}`}
                                >
                                  {run.status === 'pendente' ? (
                                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                  ) : run.status === 'ganhou' ? (
                                    <CheckCircle2 className="w-2.5 h-2.5" />
                                  ) : null}
                                  {RUN_LABELS[run.status]}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
};
