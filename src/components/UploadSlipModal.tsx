import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react';
import * as api from '../api.js';
import {
  BetSlip,
  PremierBetStatus,
  PremierBetUploadResult,
} from '../types.js';

interface UploadSlipModalProps {
  isOpen: boolean;
  slip: BetSlip | null;
  onClose: () => void;
  /** Chamado após cada tentativa (null = falhou antes de obter resultado). */
  onUploaded: (result: PremierBetUploadResult | null) => void;
}

const STAKE_STORAGE_KEY = 'bilheteria.premierbet.stake';

function formatKz(value: number): string {
  return `${new Intl.NumberFormat('pt-PT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} Kz`;
}

function formatOdds(value: number | null | undefined): string {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
}

export const UploadSlipModal: React.FC<UploadSlipModalProps> = ({
  isOpen,
  slip,
  onClose,
  onUploaded,
}) => {
  const [stake, setStake] = useState('1000');
  const [dryRun, setDryRun] = useState(false);
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<PremierBetStatus | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [result, setResult] = useState<PremierBetUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existing = slip?.upload ?? null;
  const isInProgress = existing?.status === 'in_progress';
  const isPlaced = existing?.status === 'placed';
  const isUnknown = existing?.status === 'unknown';

  // Reset + configuração ao abrir.
  useEffect(() => {
    if (!isOpen || !slip) return;
    const saved = localStorage.getItem(STAKE_STORAGE_KEY);
    const initial = existing?.stake && existing.stake > 0
      ? String(existing.stake)
      : saved || '1000';
    setStake(initial);
    setDryRun(false);
    setForce(false);
    setLoading(false);
    setStep(0);
    setResult(null);
    setError(null);
    setConfig(null);
    setConfigError(null);

    let cancelled = false;
    api
      .fetchPremierBetStatus()
      .then((status) => {
        if (cancelled) return;
        setConfig(status);
        if (status.dryRun) setDryRun(true);
        if (!existing?.stake && !saved && status.defaultStake > 0) {
          setStake(String(status.defaultStake));
        }
      })
      .catch((err: any) => {
        if (!cancelled) setConfigError(err?.message || 'Falha ao obter configuração.');
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, slip?.id]);

  // Se o estado da submissão mudar por baixo (outro separador/servidor), volta
  // a exigir confirmação explícita antes de permitir outra tentativa.
  useEffect(() => {
    setForce(false);
  }, [existing?.status]);

  // Mensagens de progresso (o pedido HTTP é síncrono; isto é só feedback).
  useEffect(() => {
    if (!loading) {
      setStep(0);
      return;
    }
    const timer = setInterval(() => {
      setStep((current) => Math.min(current + 1, 3));
    }, 6000);
    return () => clearInterval(timer);
  }, [loading]);

  const loadingSteps = useMemo(
    () => [
      'A entrar na Premier Bet...',
      'A localizar os jogos da ficha...',
      'A preencher o boletim e o valor...',
      dryRun ? 'A validar o boletim (modo de teste)...' : 'A colocar a aposta...',
    ],
    [dryRun]
  );

  if (!isOpen || !slip) return null;

  const stakeValue = Number(String(stake).replace(',', '.'));
  const stakeValid = Number.isFinite(stakeValue) && stakeValue > 0;
  const potentialReturn = stakeValid ? stakeValue * slip.combinedOdds : 0;
  const belowMinStake = Boolean(config && stakeValid && stakeValue < config.minStake);
  const aboveMaxStake = Boolean(
    config && config.maxStake > 0 && stakeValid && stakeValue > config.maxStake
  );

  const serverForcesDryRun = Boolean(config?.dryRun);
  const effectiveDryRun = dryRun || serverForcesDryRun;
  const credentialsMissing = config ? !config.configured : false;
  const scriptMissing = config ? !config.scriptExists : false;

  const requiresForce = !effectiveDryRun && (isPlaced || isUnknown || isInProgress);
  const canSubmit =
    !loading &&
    stakeValid &&
    !belowMinStake &&
    !aboveMaxStake &&
    !configError &&
    !scriptMissing &&
    !(credentialsMissing && !effectiveDryRun) &&
    (!requiresForce || force);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.uploadSlip(slip.id, {
        stake: stakeValue,
        dryRun: effectiveDryRun,
        force,
      });
      localStorage.setItem(STAKE_STORAGE_KEY, String(stakeValue));
      setResult(response);
      onUploaded(response);
    } catch (err: any) {
      setError(err?.message || 'Falha ao subir a ficha para a Premier Bet.');
      onUploaded(null);
    } finally {
      setLoading(false);
    }
  };

  const resetResult = () => {
    setResult(null);
    setError(null);
    setForce(false);
  };

  const renderUploadInfo = () => {
    if (!existing) return null;
    if (existing.status === 'in_progress') {
      return (
        <div className="rounded border border-[rgba(231,179,62,0.4)] bg-[rgba(231,179,62,0.1)] p-3 text-[11.5px] text-[#F1D79B]">
          <div className="flex items-center gap-1.5 font-semibold text-[#E7B33E]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Submissão em curso na Premier Bet</span>
          </div>
          <p className="mt-1 text-[rgba(245,243,236,0.7)]">
            Se o servidor foi reiniciado, verifica as apostas abertas na tua conta antes de tentar
            novamente.
          </p>
          <label className="mt-2 flex items-start gap-2 cursor-pointer text-[rgba(245,243,236,0.75)]">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5 accent-[#E7B33E]"
            />
            <span>Já verifiquei — tentar novamente</span>
          </label>
        </div>
      );
    }
    if (existing.status === 'placed') {
      return (
        <div className="rounded border border-[rgba(79,174,115,0.35)] bg-[rgba(79,174,115,0.1)] p-3 text-[11.5px] text-[#BFE3CD]">
          <div className="flex items-center gap-1.5 font-semibold text-[#4FAE73]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Esta ficha já está no ar na Premier Bet</span>
          </div>
          <p className="mt-1 text-[rgba(245,243,236,0.7)]">
            {formatKz(existing.stake)} · {new Date(existing.at).toLocaleString('pt-PT')}
            {existing.betId ? ` · ID ${existing.betId}` : ''}
          </p>
          <label className="mt-2 flex items-start gap-2 cursor-pointer text-[rgba(245,243,236,0.75)]">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5 accent-[#E7B33E]"
            />
            <span>Subir mesmo assim (pode duplicar a aposta)</span>
          </label>
        </div>
      );
    }
    if (existing.status === 'unknown') {
      return (
        <div className="rounded border border-[rgba(231,179,62,0.4)] bg-[rgba(231,179,62,0.1)] p-3 text-[11.5px] text-[#F1D79B]">
          <div className="flex items-center gap-1.5 font-semibold text-[#E7B33E]">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>A tentativa anterior ficou por confirmar</span>
          </div>
          <p className="mt-1 text-[rgba(245,243,236,0.7)]">
            Verifica as apostas abertas na tua conta Premier Bet. Só tenta novamente depois de
            confirmares que a aposta não foi colocada.
          </p>
          <label className="mt-2 flex items-start gap-2 cursor-pointer text-[rgba(245,243,236,0.75)]">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5 accent-[#E7B33E]"
            />
            <span>Já verifiquei — tentar novamente</span>
          </label>
        </div>
      );
    }
    if (existing.status === 'failed') {
      return (
        <div className="rounded border border-[rgba(209,89,75,0.35)] bg-[rgba(209,89,75,0.1)] p-3 text-[11.5px] text-[#F0B8B1]">
          <div className="flex items-center gap-1.5 font-semibold text-[#D1594B]">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>A última tentativa falhou</span>
          </div>
          <p className="mt-1 text-[rgba(245,243,236,0.7)]">
            {existing.message || 'Sem detalhe disponível.'}
          </p>
        </div>
      );
    }
    return (
      <div className="rounded border border-[rgba(245,243,236,0.16)] bg-[rgba(245,243,236,0.04)] p-2.5 text-[11px] text-[rgba(245,243,236,0.6)]">
        A última tentativa foi apenas um teste — nenhuma aposta foi colocada.
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-lg max-h-[92vh] overflow-y-auto bg-[#0E2A1C] border border-[rgba(245,243,236,0.22)] rounded-lg shadow-2xl p-6">
        <div className="flex items-start justify-between pb-3 border-b border-[rgba(245,243,236,0.12)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E]">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display text-2xl font-bold tracking-wide text-[#F5F3EC]">
                Subir para a Premier Bet
              </h3>
              <p className="text-xs text-[rgba(245,243,236,0.55)]">
                Ficha #{slip.id} · {slip.legs.length} jogo(s) · odd {slip.combinedOdds.toFixed(2)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer p-1.5 rounded hover:bg-[#173C27] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          <div className="mt-4 space-y-4">
            <div
              className={`rounded border p-4 ${
                result.ok
                  ? 'border-[rgba(79,174,115,0.45)] bg-[rgba(79,174,115,0.12)]'
                  : result.unknown
                    ? 'border-[rgba(231,179,62,0.45)] bg-[rgba(231,179,62,0.1)]'
                    : 'border-[rgba(209,89,75,0.45)] bg-[rgba(209,89,75,0.1)]'
              }`}
            >
              <div className="flex items-start gap-2">
                {result.ok ? (
                  <CheckCircle2 className="w-5 h-5 text-[#4FAE73] shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle
                    className={`w-5 h-5 shrink-0 mt-0.5 ${
                      result.unknown ? 'text-[#E7B33E]' : 'text-[#D1594B]'
                    }`}
                  />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#F5F3EC]">
                    {result.ok
                      ? result.dryRun
                        ? 'Boletim preenchido (modo de teste)'
                        : 'Ficha colocada na Premier Bet'
                      : result.unknown
                        ? 'Colocação por confirmar'
                        : 'Aposta não colocada'}
                  </p>
                  <p className="text-xs text-[rgba(245,243,236,0.75)] mt-1 whitespace-pre-wrap">
                    {result.message}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[rgba(245,243,236,0.6)]">
                    <span>
                      {result.filled}/{slip.legs.length} seleção(ões)
                    </span>
                    <span>Odd {formatOdds(result.totalOdds ?? slip.combinedOdds)}</span>
                    <span>{formatKz(result.stake)}</span>
                    {result.betId && <span>ID {result.betId}</span>}
                  </div>
                </div>
              </div>
              {result.detail && !result.ok && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] text-[rgba(245,243,236,0.55)] hover:text-[#F5F3EC]">
                    Ver detalhe técnico
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[rgba(245,243,236,0.55)] bg-[#081C13] rounded p-2">
                    {result.detail}
                  </pre>
                </details>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              {!result.ok && (
                <button
                  type="button"
                  onClick={resetResult}
                  className="cursor-pointer px-4 py-2 rounded border border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.75)] hover:text-[#F5F3EC] text-xs font-semibold"
                >
                  Tentar novamente
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer px-4 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] font-semibold text-xs"
              >
                Fechar
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {renderUploadInfo()}

            {/* Resumo da ficha */}
            <div className="rounded border border-[rgba(245,243,236,0.12)] bg-[#0E2A1C]/70 p-3">
              <div className="flex items-center justify-between text-[11px] text-[rgba(245,243,236,0.55)]">
                <span>Odd combinada da ficha</span>
                <span className="font-mono text-sm text-[#F5F3EC]">
                  {slip.combinedOdds.toFixed(2)}
                </span>
              </div>
              <div className="mt-1.5 max-h-24 overflow-y-auto space-y-1">
                {slip.legs.map((leg, idx) => (
                  <div
                    key={`${leg.id}-${idx}`}
                    className="flex items-center justify-between gap-2 text-[11px]"
                  >
                    <span className="truncate text-[rgba(245,243,236,0.75)]">
                      {leg.home} × {leg.away}
                    </span>
                    <span className="shrink-0 text-[#E7B33E]">{leg.tip.label}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-[rgba(245,243,236,0.4)]">
                Os jogos e as tips são localizados automaticamente na Premier Bet. A odd final pode
                variar ligeiramente.
              </p>
            </div>

            {/* Valor */}
            <div>
              <label
                htmlFor="premierbet-stake"
                className="block text-xs font-semibold text-[rgba(245,243,236,0.7)] uppercase tracking-wider mb-1.5"
              >
                Valor da aposta
              </label>
              <div className="flex items-stretch gap-2">
                <div className="relative flex-1">
                  <input
                    id="premierbet-stake"
                    type="number"
                    inputMode="decimal"
                    min={config?.minStake ?? 1}
                    max={config && config.maxStake > 0 ? config.maxStake : undefined}
                    step="0.01"
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    disabled={loading}
                    className="w-full rounded bg-[#081C13] border border-[rgba(245,243,236,0.18)] px-3 py-2.5 pr-12 text-sm text-[#F5F3EC] focus:border-[#E7B33E] focus:outline-none disabled:opacity-50"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[rgba(245,243,236,0.45)]">
                    Kz
                  </span>
                </div>
                {[500, 1000, 2000, 5000].map((quick) => (
                  <button
                    key={quick}
                    type="button"
                    onClick={() => setStake(String(quick))}
                    disabled={loading}
                    className="cursor-pointer px-2.5 rounded border border-[rgba(245,243,236,0.16)] text-[11px] text-[rgba(245,243,236,0.7)] hover:border-[#E7B33E]/60 hover:text-[#E7B33E] disabled:opacity-50"
                  >
                    {quick}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-[rgba(245,243,236,0.5)]">
                <span>Retorno potencial (odd da ficha)</span>
                <span className="font-mono text-[#4FAE73]">{formatKz(potentialReturn)}</span>
              </div>
              {config && (belowMinStake || aboveMaxStake) && (
                <p className="mt-1 text-[10.5px] text-[#D1594B]">
                  {belowMinStake
                    ? `O valor mínimo é ${formatKz(config.minStake)}.`
                    : `O valor máximo configurado é ${formatKz(config.maxStake)}.`}
                </p>
              )}
            </div>

            {/* Modo de teste */}
            <label
              className={`flex items-start gap-2 rounded border p-2.5 text-[11px] cursor-pointer ${
                serverForcesDryRun
                  ? 'border-[rgba(231,179,62,0.35)] bg-[rgba(231,179,62,0.08)]'
                  : 'border-[rgba(245,243,236,0.14)] bg-[rgba(245,243,236,0.03)]'
              }`}
            >
              <input
                type="checkbox"
                checked={effectiveDryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                disabled={loading || serverForcesDryRun}
                className="mt-0.5 accent-[#E7B33E]"
              />
              <span className="text-[rgba(245,243,236,0.75)]">
                <span className="font-semibold text-[#F5F3EC]">Modo de teste</span> — preenche o
                boletim na Premier Bet, mas não coloca a aposta.
                {serverForcesDryRun && (
                  <span className="block mt-0.5 text-[#E7B33E]">
                    Ativo no servidor (PREMIERBET_DRY_RUN=1).
                  </span>
                )}
              </span>
            </label>

            {/* Aviso de dinheiro real */}
            {!effectiveDryRun && (
              <div className="flex items-start gap-2 rounded border border-[rgba(209,89,75,0.3)] bg-[rgba(209,89,75,0.08)] p-2.5 text-[11px] text-[#F0B8B1]">
                <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-[#D1594B]" />
                <span>
                  Ao confirmar, a aposta é colocada com <strong>dinheiro real</strong> na tua conta
                  Premier Bet. Confirma o valor antes de continuar.
                </span>
              </div>
            )}

            {configError && (
              <div className="rounded border border-[rgba(209,89,75,0.35)] bg-[rgba(209,89,75,0.1)] p-2.5 text-[11px] text-[#F0B8B1]">
                {configError}
              </div>
            )}
            {scriptMissing && (
              <div className="rounded border border-[rgba(209,89,75,0.35)] bg-[rgba(209,89,75,0.1)] p-2.5 text-[11px] text-[#F0B8B1]">
                A automação da Premier Bet não está instalada no servidor.
              </div>
            )}
            {credentialsMissing && !effectiveDryRun && (
              <div className="rounded border border-[rgba(231,179,62,0.35)] bg-[rgba(231,179,62,0.08)] p-2.5 text-[11px] text-[#F1D79B]">
                Credenciais não configuradas no servidor. Define{' '}
                <code className="font-mono">PREMIERBET_LOGIN</code> e{' '}
                <code className="font-mono">PREMIERBET_PASSWORD</code> no <code>.env</code>. Podes
                usar o modo de teste para validar o boletim.
              </div>
            )}
            {error && (
              <div className="rounded border border-[rgba(209,89,75,0.35)] bg-[rgba(209,89,75,0.1)] p-2.5 text-[11px] text-[#F0B8B1] whitespace-pre-wrap">
                {error}
              </div>
            )}

            {loading && (
              <div className="rounded border border-[rgba(231,179,62,0.3)] bg-[rgba(231,179,62,0.07)] p-3 text-[11px] text-[#F1D79B]">
                <div className="flex items-center gap-2 font-medium">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{loadingSteps[step]}</span>
                </div>
                <p className="mt-1 text-[rgba(245,243,236,0.5)]">
                  Pode demorar até 2–3 minutos. A operação continua no servidor mesmo que feches
                  esta janela.
                </p>
              </div>
            )}

            <div className="pt-2 border-t border-[rgba(245,243,236,0.1)] flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="cursor-pointer px-4 py-2 rounded border border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.7)] hover:text-[#F5F3EC] text-xs font-semibold disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="cursor-pointer px-4 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="w-3.5 h-3.5" />
                )}
                <span>
                  {loading
                    ? 'A subir...'
                    : effectiveDryRun
                      ? 'Testar boletim (sem apostar)'
                      : `Subir e apostar ${stakeValid ? formatKz(stakeValue) : ''}`}
                </span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
