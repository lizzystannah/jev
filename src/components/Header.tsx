import React, { useState, useEffect } from 'react';
import { BackendStatus } from '../types.js';
import { Server, Sparkles, RefreshCw, Clock, Globe, Zap, Loader2 } from 'lucide-react';
import { TIMEZONE_OPTIONS, formatTimeInTz } from '../utils/timezone.js';

interface HeaderProps {
  status: BackendStatus | null;
  onOpenApiModal: () => void;
  onOpenAiSlipModal: () => void;
  onRefresh: () => void;
  onGenerate: () => void;
  generating: boolean;
  loading: boolean;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  status,
  onOpenApiModal,
  onOpenAiSlipModal,
  onRefresh,
  onGenerate,
  generating,
  loading,
  timezone,
  onTimezoneChange,
}) => {
  const isExternalApi = status?.provider?.isExternalApi;
  const providerName = status?.provider?.providerName || 'Motor Inteligente';
  const hasGemini = status?.aiEngine?.hasGeminiApiKey;

  const [currentTimeStr, setCurrentTimeStr] = useState('');
  const [isTzMenuOpen, setIsTzMenuOpen] = useState(false);

  useEffect(() => {
    const updateTime = () => {
      setCurrentTimeStr(formatTimeInTz(Date.now(), timezone));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, [timezone]);

  const currentTzOption = TIMEZONE_OPTIONS.find((t) => t.id === timezone) || {
    id: timezone,
    label: timezone.split('/').pop()?.replace(/_/g, ' ') || timezone,
    offsetLabel: 'UTC',
    city: timezone.split('/').pop() || timezone,
  };

  return (
    <header className="sticky top-0 z-30 bg-[#081C13]/90 backdrop-blur-md border-b border-[rgba(245,243,236,0.14)]">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-3xl font-bold tracking-wide text-[#F5F3EC]">
            Bilhet<span className="text-[#E7B33E]">eria</span>
          </span>
          <span className="text-xs text-[rgba(245,243,236,0.38)] border-l border-[rgba(245,243,236,0.28)] pl-2.5 hidden sm:inline">
            motor de bilhetes e odds de mercado
          </span>
        </div>

        {/* Status Indicators, Timezone & Action Buttons */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Timezone & Clock Pill */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsTzMenuOpen(!isTzMenuOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border cursor-pointer bg-[#0E2A1C] hover:bg-[#173C27] border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.9)]"
              title="Clique para alterar o Fuso Horário"
            >
              <Clock className="w-3.5 h-3.5 text-[#E7B33E]" />
              <span className="font-mono font-bold text-[#F5F3EC]">{currentTimeStr || '02:00'}</span>
              <span className="text-[10px] text-[rgba(245,243,236,0.55)] hidden md:inline">
                ({currentTzOption.city})
              </span>
            </button>

            {isTzMenuOpen && (
              <div className="absolute right-0 mt-2 w-64 rounded-lg bg-[#0E2A1C] border border-[rgba(245,243,236,0.18)] shadow-2xl p-2 z-50">
                <div className="px-2 py-1.5 text-[11px] font-semibold text-[#E7B33E] flex items-center gap-1 border-b border-[rgba(245,243,236,0.1)] mb-1">
                  <Globe className="w-3.5 h-3.5" />
                  <span>Selecionar Fuso Horário</span>
                </div>
                <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
                  {TIMEZONE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        onTimezoneChange(opt.id);
                        setIsTzMenuOpen(false);
                      }}
                      className={`text-left px-2.5 py-1.5 rounded text-xs transition-colors flex items-center justify-between cursor-pointer ${
                        timezone === opt.id
                          ? 'bg-[#20502F] text-[#F5F3EC] font-semibold'
                          : 'text-[rgba(245,243,236,0.7)] hover:bg-[#173C27] hover:text-[#F5F3EC]'
                      }`}
                    >
                      <span>{opt.label}</span>
                      <span className="text-[10px] font-mono text-[#E7B33E] bg-[#081C13] px-1 py-0.5 rounded">
                        {opt.offsetLabel}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Market API Status Pill */}
          <button
            type="button"
            onClick={onOpenApiModal}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border cursor-pointer bg-[#0E2A1C] hover:bg-[#173C27] border-[rgba(245,243,236,0.2)] text-[rgba(245,243,236,0.85)]"
            title="Clique para ver configuração e adicionar API no .env"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isExternalApi ? 'bg-[#4FAE73] animate-pulse-subtle' : 'bg-[#E7B33E]'
              }`}
            />
            <Server className="w-3.5 h-3.5 text-[#E7B33E]" />
            <span className="hidden md:inline">Fonte:</span>
            <span className="font-semibold text-[#F5F3EC] truncate max-w-[120px] sm:max-w-none">
              {providerName}
            </span>
          </button>

          {/* Generate Quick Trigger (disponível em qualquer parte do site) */}
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border cursor-pointer bg-[#E7B33E] hover:bg-[#F0C869] border-[#E7B33E] text-[#3A2A06] disabled:opacity-60"
            title="Gerar novas fichas para o horizonte ativo"
          >
            {generating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5 fill-current" />
            )}
            <span className="hidden sm:inline">Gerar</span>
          </button>

          {/* AI Generation Quick Trigger */}
          <button
            type="button"
            onClick={onOpenAiSlipModal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border cursor-pointer bg-[rgba(231,179,62,0.12)] hover:bg-[rgba(231,179,62,0.22)] border-[rgba(231,179,62,0.35)] text-[#E7B33E]"
            title={hasGemini ? 'Gemini 3.8 Flash conectado' : 'Modo IA Ativo'}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span className="font-semibold">Bilhete IA</span>
          </button>

          {/* Refresh button */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="p-2 rounded border border-[rgba(245,243,236,0.18)] bg-[#0E2A1C] hover:bg-[#173C27] text-[rgba(245,243,236,0.7)] hover:text-[#F5F3EC] transition-all cursor-pointer disabled:opacity-50"
            title="Atualizar dados do servidor"
            aria-label="Atualizar dados"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
    </header>
  );
};
