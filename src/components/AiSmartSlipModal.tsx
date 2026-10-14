import React, { useState } from 'react';
import { X, Sparkles, CheckCircle2 } from 'lucide-react';

interface AiSmartSlipModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (preference: string) => Promise<void>;
  loading: boolean;
}

export const AiSmartSlipModal: React.FC<AiSmartSlipModalProps> = ({
  isOpen,
  onClose,
  onGenerate,
  loading,
}) => {
  const [preference, setPreference] = useState('');

  if (!isOpen) return null;

  const presets = [
    { label: 'Alta Probabilidade & Menor Risco', prompt: 'Priorize os jogos mais equilibrados com probabilidade acima de 65% e odds estáveis' },
    { label: 'Equilibrado (Odd ~3.50 a 5.00)', prompt: 'Monte uma múltipla moderada com odd final combinada entre 3.50 e 5.00' },
    { label: 'Foco em Mercado de Golos', prompt: 'Selecione jogos com maior tendência para Mais de 2.5 golos ou Ambas Marcam Sim' },
    { label: 'Ousada com Grande Retorno', prompt: 'Busque valor em vitórias de equipas visitantes com odds atrativas' },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onGenerate(preference || presets[0].prompt);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-lg bg-[#0E2A1C] border border-[rgba(245,243,236,0.22)] rounded-lg shadow-2xl p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[rgba(245,243,236,0.12)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display text-2xl font-bold tracking-wide text-[#F5F3EC]">
                Gerador de Bilhete com IA
              </h3>
              <p className="text-xs text-[rgba(245,243,236,0.55)]">
                O Gemini analisa o banco de odds e monta uma seleção sob medida
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer p-1.5 rounded hover:bg-[#173C27] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[rgba(245,243,236,0.7)] uppercase tracking-wider mb-2">
              Escolha uma estratégia predefinida
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {presets.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setPreference(preset.prompt)}
                  className={`cursor-pointer text-left p-2.5 rounded text-xs border transition-colors ${
                    preference === preset.prompt
                      ? 'bg-[#20502F] border-[#4FAE73] text-[#F5F3EC]'
                      : 'bg-[#173C27]/60 border-[rgba(245,243,236,0.12)] text-[rgba(245,243,236,0.75)] hover:border-[rgba(245,243,236,0.25)]'
                  }`}
                >
                  <div className="font-semibold text-[#F5F3EC] flex items-center justify-between">
                    <span>{preset.label}</span>
                    {preference === preset.prompt && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#4FAE73]" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[rgba(245,243,236,0.7)] uppercase tracking-wider mb-1.5">
              Ou digite sua instrução personalizada
            </label>
            <textarea
              value={preference}
              onChange={(e) => setPreference(e.target.value)}
              placeholder="Ex: Quero um bilhete de 3 jogos do Brasileirão e Premier League com foco em equipas favoritas jogando em casa..."
              rows={3}
              className="w-full rounded bg-[#081C13] border border-[rgba(245,243,236,0.18)] p-3 text-xs text-[#F5F3EC] placeholder-[rgba(245,243,236,0.35)] focus:border-[#E7B33E] focus:outline-none"
            />
          </div>

          <div className="pt-2 border-t border-[rgba(245,243,236,0.1)] flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer px-4 py-2 rounded border border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.7)] hover:text-[#F5F3EC] text-xs font-semibold"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="cursor-pointer px-4 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{loading ? 'A gerar com IA...' : 'Montar Bilhete'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
