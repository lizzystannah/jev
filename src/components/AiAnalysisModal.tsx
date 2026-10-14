import React from 'react';
import { MatchItem, AiMatchAnalysis } from '../types.js';
import { X, Sparkles, ShieldAlert, Award, TrendingUp } from 'lucide-react';

interface AiAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  match: MatchItem | null;
  analysis: AiMatchAnalysis | null;
  loading: boolean;
}

export const AiAnalysisModal: React.FC<AiAnalysisModalProps> = ({
  isOpen,
  onClose,
  match,
  analysis,
  loading,
}) => {
  if (!isOpen || !match) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-xl bg-[#0E2A1C] border border-[rgba(245,243,236,0.22)] rounded-lg shadow-2xl p-6 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[rgba(245,243,236,0.12)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-[rgba(231,179,62,0.15)] text-[#E7B33E]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[11px] uppercase tracking-wider text-[rgba(245,243,236,0.45)]">
                {match.league} · Análise com IA
              </span>
              <h3 className="font-display text-2xl font-bold tracking-wide text-[#F5F3EC]">
                {match.home} × {match.away}
              </h3>
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

        {/* Body */}
        <div className="overflow-y-auto py-4 space-y-4">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <Sparkles className="w-8 h-8 text-[#E7B33E] animate-spin mb-3" />
              <p className="text-sm text-[#F5F3EC] font-medium">A consultar IA (OpenRouter Free / Gemini)...</p>
              <p className="text-xs text-[rgba(245,243,236,0.5)] mt-1">
                Cruzando dados estatísticos, momento das equipas e odds de mercado em tempo real.
              </p>
            </div>
          ) : analysis ? (
            <>
              {/* Highlight Box */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 p-3.5 rounded bg-[#173C27] border border-[rgba(245,243,236,0.12)]">
                <div>
                  <div className="text-[10.5px] uppercase tracking-wider text-[rgba(245,243,236,0.45)] flex items-center gap-1">
                    <Award className="w-3 h-3 text-[#E7B33E]" />
                    Recomendação
                  </div>
                  <div className="text-sm font-semibold text-[#F5F3EC] mt-0.5 truncate">
                    {analysis.recommendedMarket}
                  </div>
                </div>

                <div>
                  <div className="text-[10.5px] uppercase tracking-wider text-[rgba(245,243,236,0.45)] flex items-center gap-1">
                    <TrendingUp className="w-3 h-3 text-[#4FAE73]" />
                    Confiança IA
                  </div>
                  <div className="text-sm font-semibold text-[#4FAE73] mt-0.5">
                    {analysis.confidenceScore}%
                  </div>
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <div className="text-[10.5px] uppercase tracking-wider text-[rgba(245,243,236,0.45)] flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3 text-[#E7B33E]" />
                    Nível de Risco
                  </div>
                  <div
                    className={`text-sm font-semibold mt-0.5 ${
                      analysis.riskLevel === 'Baixo'
                        ? 'text-[#4FAE73]'
                        : analysis.riskLevel === 'Alto'
                        ? 'text-[#D1594B]'
                        : 'text-[#E7B33E]'
                    }`}
                  >
                    {analysis.riskLevel}
                  </div>
                </div>
              </div>

              {/* Tactical Summary */}
              <div>
                <h4 className="text-xs font-semibold text-[#E7B33E] uppercase tracking-wider mb-1.5">
                  Parecer Tático
                </h4>
                <p className="text-xs text-[rgba(245,243,236,0.85)] leading-relaxed bg-[#081C13]/70 p-3 rounded border border-[rgba(245,243,236,0.08)]">
                  {analysis.tacticalSummary}
                </p>
              </div>

              {/* Key Factors */}
              <div>
                <h4 className="text-xs font-semibold text-[rgba(245,243,236,0.65)] uppercase tracking-wider mb-2">
                  Fatores Críticos do Confronto
                </h4>
                <ul className="space-y-1.5 text-xs text-[rgba(245,243,236,0.8)]">
                  {analysis.keyFactors.map((factor, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-[#E7B33E] mt-0.5">•</span>
                      <span>{factor}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Match Odds Context */}
              <div className="pt-2 border-t border-[rgba(245,243,236,0.1)]">
                <div className="text-[10.5px] text-[rgba(245,243,236,0.45)] uppercase tracking-wider mb-1.5">
                  Odds Decimal do Mercado
                </div>
                <div className="grid grid-cols-4 gap-1 text-center font-display text-sm">
                  <div className="bg-[#173C27]/50 p-1.5 rounded">
                    <span className="text-[10px] block text-[rgba(245,243,236,0.4)]">1 (Casa)</span>
                    <span className="text-[#F5F3EC]">{match.odds.home.toFixed(2)}</span>
                  </div>
                  <div className="bg-[#173C27]/50 p-1.5 rounded">
                    <span className="text-[10px] block text-[rgba(245,243,236,0.4)]">X (Empate)</span>
                    <span className="text-[#F5F3EC]">{match.odds.draw.toFixed(2)}</span>
                  </div>
                  <div className="bg-[#173C27]/50 p-1.5 rounded">
                    <span className="text-[10px] block text-[rgba(245,243,236,0.4)]">2 (Fora)</span>
                    <span className="text-[#F5F3EC]">{match.odds.away.toFixed(2)}</span>
                  </div>
                  <div className="bg-[#173C27]/50 p-1.5 rounded">
                    <span className="text-[10px] block text-[rgba(245,243,236,0.4)]">+2.5 Golos</span>
                    <span className="text-[#F5F3EC]">{match.odds.over25.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center text-xs text-[rgba(245,243,236,0.5)] py-6">
              Nenhuma análise disponível para este confronto.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-[rgba(245,243,236,0.12)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer px-4 py-2 rounded bg-[#E7B33E] hover:bg-[#F0C869] text-[#3A2A06] font-semibold text-xs transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
