import React, { useState } from 'react';
import { BackendStatus } from '../types.js';
import { X, Check, Copy, ExternalLink, RefreshCw, Server, AlertCircle, Cpu } from 'lucide-react';

interface ApiConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: BackendStatus | null;
  onRefresh: () => void;
  loading: boolean;
}

export const ApiConfigModal: React.FC<ApiConfigModalProps> = ({
  isOpen,
  onClose,
  status,
  onRefresh,
  loading,
}) => {
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  if (!isOpen) return null;

  const provider = status?.provider;
  const jevEngine = status?.jevEngine;
  const isExternal = provider?.isExternalApi;

  const envSample = `# ==============================================================================
# MOTOR OPENROUTER (Análise Tática & Bilhetes IA via openrouter/free)
# ==============================================================================
OPENROUTER_API_KEY="sk-or-v1-..."
OPENROUTER_MODEL="openrouter/free"
OPENROUTER_JEV_MODEL="openrouter/free"

# ==============================================================================
# THE ODDS API (https://the-odds-api.com/account/)
# ==============================================================================
ODDS_API_KEY="SUA_CHAVE_OBTIDA_NO_DASHBOARD"
ODDS_API_REGIONS="eu"
ODDS_API_MARKETS="h2h"`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(envSample);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-2xl bg-[#0E2A1C] border border-[rgba(245,243,236,0.22)] rounded-lg shadow-2xl p-6 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[rgba(245,243,236,0.12)]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-[#173C27] text-[#E7B33E]">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display text-2xl font-bold tracking-wide text-[#F5F3EC]">
                Configuração da API de Mercado & Jev
              </h3>
              <p className="text-xs text-[rgba(245,243,236,0.55)]">
                Conecte dados de odds e o modelo Jev (TypeSafe AI) para calibração probabilística
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer p-1.5 rounded hover:bg-[#173C27] text-[rgba(245,243,236,0.6)] hover:text-[#F5F3EC] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto py-4 space-y-5 text-sm">
          {/* Jev Engine Status Box */}
          <div className="p-4 rounded bg-[#173C27]/90 border border-[#4FAE73]/30">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-[#4FAE73] font-semibold flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-[#E7B33E]" />
                  <span>Motor Jev AI (TypeSafe AI)</span>
                </div>
                <div className="text-base font-semibold text-[#F5F3EC] mt-1 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#4FAE73]" />
                  <span>{jevEngine?.modelVersion || 'openrouter/~typesafe/jev-latest'}</span>
                </div>
                <p className="text-xs text-[rgba(245,243,236,0.7)] mt-1.5 leading-relaxed">
                  Decisões tipadas (choice & noul) via OpenRouter System One (<code>/api/v1/systemone</code>). Todos os bilhetes são estritamente condicionados e calibrados pela inferência do Jev.
                </p>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-[rgba(245,243,236,0.08)] grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div>
                <span className="text-[rgba(245,243,236,0.45)]">Modo:</span>{' '}
                <strong className="text-[#4FAE73]">
                  {jevEngine?.isRemoteKeyConfigured ? 'OpenRouter Jev (Ativo)' : 'Não Configurado'}
                </strong>
              </div>
              <div>
                <span className="text-[rgba(245,243,236,0.45)]">Latência:</span>{' '}
                <strong className="text-[#E7B33E]">{jevEngine?.latencyMs || 55} ms</strong>
              </div>
              <div className="col-span-2 sm:col-span-1 truncate">
                <span className="text-[rgba(245,243,236,0.45)]">Horizontes:</span>{' '}
                <strong className="text-[#F5F3EC]">Hoje / 2-3d / Longo</strong>
              </div>
            </div>
          </div>

          {/* Current Market Status Box */}
          <div className="p-4 rounded bg-[#173C27]/70 border border-[rgba(245,243,236,0.12)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-[rgba(245,243,236,0.4)] font-semibold">
                  Status da Fonte de Mercado
                </div>
                <div className="text-lg font-semibold text-[#F5F3EC] mt-0.5 flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      isExternal ? 'bg-[#4FAE73]' : 'bg-[#E7B33E]'
                    }`}
                  />
                  <span>{provider?.providerName || 'Carregando...'}</span>
                </div>
                <p className="text-xs text-[rgba(245,243,236,0.7)] mt-1.5 leading-relaxed">
                  {provider?.message}
                </p>
              </div>

              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="cursor-pointer shrink-0 text-xs px-3 py-1.5 rounded bg-[#0E2A1C] hover:bg-[#20502F] border border-[rgba(245,243,236,0.2)] text-[#F5F3EC] flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>Atualizar</span>
              </button>
            </div>

            <div className="mt-3 pt-3 border-t border-[rgba(245,243,236,0.08)] grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div>
                <span className="text-[rgba(245,243,236,0.45)]">Jogos ativos:</span>{' '}
                <strong className="text-[#F5F3EC]">{provider?.totalMatches || 0}</strong>
              </div>
              <div>
                <span className="text-[rgba(245,243,236,0.45)]">Chave .env:</span>{' '}
                <strong className={provider?.apiKeyConfigured ? 'text-[#4FAE73]' : 'text-[#E7B33E]'}>
                  {provider?.apiKeyConfigured ? 'Detectada' : 'Simulador local'}
                </strong>
              </div>
              <div className="col-span-2 sm:col-span-1 truncate">
                <span className="text-[rgba(245,243,236,0.45)]">Quota Restante:</span>{' '}
                <strong className="text-[#E7B33E]">
                  {provider?.rateLimitInfo?.requestsRemaining !== undefined
                    ? `${provider.rateLimitInfo.requestsRemaining} req`
                    : 'Disponível'}
                </strong>
              </div>
            </div>
          </div>

          {/* Guide */}
          <div>
            <h4 className="text-sm font-semibold text-[#E7B33E] uppercase tracking-wider mb-2">
              Como configurar o arquivo .env
            </h4>
            <p className="text-xs text-[rgba(245,243,236,0.75)] leading-relaxed mb-3">
              Abra o arquivo <code className="px-1.5 py-0.5 rounded bg-black/40 text-[#E7B33E]">.env</code> na raiz do projeto para adicionar chaves da The Odds API ou da TypeSafe AI (Jev).
            </p>
          </div>

          {/* Code Snippet */}
          <div className="relative rounded bg-[#081C13] border border-[rgba(245,243,236,0.14)] p-3 text-xs font-mono">
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-[rgba(245,243,236,0.1)]">
              <span className="text-[rgba(245,243,236,0.5)] text-[11px]">Exemplo para o .env</span>
              <button
                type="button"
                onClick={copyToClipboard}
                className="cursor-pointer text-xs text-[#E7B33E] hover:underline flex items-center gap-1"
              >
                {copiedSnippet ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#4FAE73]" />
                    <span className="text-[#4FAE73]">Copiado!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar snippet</span>
                  </>
                )}
              </button>
            </div>
            <pre className="text-[rgba(245,243,236,0.8)] overflow-x-auto whitespace-pre leading-relaxed text-[11.5px]">
              {envSample}
            </pre>
          </div>

          {/* Info Banner */}
          <div className="p-3 rounded bg-[rgba(231,179,62,0.08)] border border-[rgba(231,179,62,0.25)] flex items-start gap-2.5 text-xs text-[rgba(245,243,236,0.8)]">
            <AlertCircle className="w-4 h-4 text-[#E7B33E] shrink-0 mt-0.5" />
            <div>
              <strong>Processamento em tempo real:</strong> O Jev não alucina e opera sob decisões delimitadas. Ao selecionar <em>Hoje</em>, <em>2 a 3 dias</em> ou <em>Longo prazo</em>, o contexto é adaptado e as fichas são montadas e calculadas instantaneamente.
            </div>
          </div>
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
