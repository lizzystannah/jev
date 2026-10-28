import React, { useEffect, useState } from 'react';
import { CartLeg, SlipTier } from '../types.js';
import { X, ShoppingCart, Trash2, Loader2, AlertCircle, Calendar } from 'lucide-react';

type SlipScopeOption = 'dia' | '2_3_dias' | 'longo';

interface CustomSlipDrawerProps {
  isOpen: boolean;
  legs: CartLeg[];
  defaultScope: SlipScopeOption;
  creating: boolean;
  onClose: () => void;
  onRemove: (matchId: string, market: string) => void;
  onClear: () => void;
  onCreate: (
    scope: SlipScopeOption,
    tier?: SlipTier
  ) => Promise<{ ok: boolean; error?: string }>;
}

const scopeOptions: Array<{ id: SlipScopeOption; label: string }> = [
  { id: 'dia', label: 'Hoje' },
  { id: '2_3_dias', label: '2 a 3 dias' },
  { id: 'longo', label: 'Longo prazo' },
];

const tierOptions: Array<{ id: SlipTier; label: string }> = [
  { id: 'segura', label: 'Segura' },
  { id: 'moderada', label: 'Moderada' },
  { id: 'ousada', label: 'Ousada' },
  { id: 'maluca', label: 'Maluca' },
  { id: 'compostas', label: 'Compostas' },
];

export const CustomSlipDrawer: React.FC<CustomSlipDrawerProps> = ({
  isOpen,
  legs,
  defaultScope,
  creating,
  onClose,
  onRemove,
  onClear,
  onCreate,
}) => {
  const [scope, setScope] = useState<SlipScopeOption>(defaultScope);
  const [tier, setTier] = useState<SlipTier | ''>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setScope(defaultScope);
      setTier('');
      setError(null);
    }
  }, [isOpen, defaultScope]);

  if (!isOpen) return null;

  const combinedOdds = legs.reduce((acc, leg) => acc * leg.odds, 1);
  const combinedProb = legs.reduce((acc, leg) => acc * (leg.prob / 100), 1) * 100;

  const handleSubmit = async () => {
    setError(null);
    if (legs.length === 0) {
      setError('Adiciona pelo menos uma seleção antes de criar a ficha.');
      return;
    }
    const result = await onCreate(scope, tier || undefined);
    if (!result.ok) {
      setError(result.error || 'Não foi possível criar a ficha manual.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm animate-fadeIn">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      <aside className="relative h-full w-full max-w-md bg-[#0E2A1C] border-l border-[rgba(245,243,236,0.18)] shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[rgba(245,243,236,0.12)] flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E]">
              <ShoppingCart className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display text-2xl font-bold tracking-wide text-[#F5F3EC]">
                Ficha manual
              </h3>
              <p className="text-xs text-[rgba(245,243,236,0.55)]">
                {legs.length} seleç{legs.length === 1 ? 'ão' : 'ões'} no carrinho
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer p-1.5 rounded hover:bg-[#173C27] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]"
            title="Fechar carrinho"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Legs */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
          {legs.length === 0 ? (
            <div className="border border-dashed border-[rgba(245,243,236,0.2)] rounded-lg p-6 text-center text-xs text-[rgba(245,243,236,0.55)]">
              O carrinho está vazio. Usa o botão <strong className="text-[#F5F3EC]">+</strong> nos
              chips de tip dos jogos para adicionar seleções.
            </div>
          ) : (
            legs.map((leg) => (
              <div
                key={`${leg.matchId}-${leg.market}`}
                className="rounded border border-[rgba(245,243,236,0.12)] bg-[#173C27]/70 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10.5px] text-[rgba(245,243,236,0.45)] truncate">
                      {leg.league}
                    </div>
                    <div className="text-[13px] font-medium text-[#F5F3EC] truncate">
                      {leg.home} <span className="text-[rgba(245,243,236,0.4)]">vs</span> {leg.away}
                    </div>
                    <div className="mt-0.5 text-[12px] text-[#E7B33E] font-medium truncate">
                      {leg.label}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(leg.matchId, leg.market)}
                    className="cursor-pointer shrink-0 p-1 rounded text-[rgba(245,243,236,0.45)] hover:text-[#D1594B] hover:bg-[rgba(209,89,75,0.12)]"
                    title="Remover seleção"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[11px]">
                  <span className="text-[rgba(245,243,236,0.55)]">
                    Probabilidade <strong className="text-[#4FAE73]">{leg.prob}%</strong>
                  </span>
                  <span className="font-display text-[#F5F3EC] font-semibold">
                    odd {leg.odds.toFixed(2)}
                  </span>
                </div>
              </div>
            ))
          )}

          {legs.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="cursor-pointer text-[11px] text-[rgba(245,243,236,0.5)] hover:text-[#D1594B] flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              <span>Limpar carrinho</span>
            </button>
          )}
        </div>

        {/* Configuração e criação */}
        <div className="px-5 py-4 border-t border-[rgba(245,243,236,0.12)] space-y-4 bg-[#081C13]/60">
          <div>
            <label className="block text-[11px] font-semibold text-[rgba(245,243,236,0.65)] uppercase tracking-wider mb-1.5">
              Escopo
            </label>
            <div className="flex flex-wrap gap-2">
              {scopeOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setScope(option.id)}
                  className={`cursor-pointer text-xs px-3 py-1.5 rounded-full border transition-all ${
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
              htmlFor="custom-slip-tier"
              className="block text-[11px] font-semibold text-[rgba(245,243,236,0.65)] uppercase tracking-wider mb-1.5"
            >
              Perfil de risco (opcional)
            </label>
            <select
              id="custom-slip-tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as SlipTier | '')}
              className="w-full rounded bg-[#0E2A1C] border border-[rgba(245,243,236,0.18)] px-3 py-2 text-xs text-[#F5F3EC] focus:border-[#E7B33E] focus:outline-none"
            >
              <option value="">Automático (definido pelo motor)</option>
              {tierOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between text-xs text-[rgba(245,243,236,0.6)]">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-[#E7B33E]" />
              Odd combinada
            </span>
            <span className="font-display text-lg font-bold text-[#F5F3EC]">
              {legs.length > 0 ? combinedOdds.toFixed(2) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-[rgba(245,243,236,0.6)]">
            <span>Probabilidade combinada</span>
            <span className="font-display text-lg font-bold text-[#4FAE73]">
              {legs.length > 0 ? `${combinedProb.toFixed(1)}%` : '—'}
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-1.5 rounded border border-[rgba(209,89,75,0.35)] bg-[rgba(209,89,75,0.12)] px-2.5 py-2 text-[11px] text-[#D1594B]">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={creating || legs.length === 0}
            className="cursor-pointer w-full inline-flex items-center justify-center gap-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] px-4 py-2.5 text-sm font-semibold text-[#3A2A06] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ShoppingCart className="w-4 h-4" />
            )}
            <span>{creating ? 'A criar ficha...' : 'Criar ficha'}</span>
          </button>
        </div>
      </aside>
    </div>
  );
};
