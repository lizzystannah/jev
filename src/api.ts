import {
  BackendStatus,
  MatchItem,
  BetSlip,
  BetEngine,
  AiMatchAnalysis,
  TicketStockStatus,
  PremierBetStatus,
  PremierBetUploadResult,
  SlipUpload,
  TipMarket,
  SlipTier,
  JevStatus,
  Progression,
  CreateProgressionInput,
} from './types.js';

export async function fetchBackendStatus(): Promise<BackendStatus> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Falha ao conectar com o servidor');
  return res.json();
}

export async function fetchMatches(forceRefresh = false): Promise<MatchItem[]> {
  const res = await fetch(`/api/matches${forceRefresh ? '?refresh=true' : ''}`);
  if (!res.ok) throw new Error('Falha ao carregar jogos');
  return res.json();
}

export async function fetchTickets(): Promise<BetSlip[]> {
  const res = await fetch('/api/tickets');
  if (!res.ok) throw new Error('Falha ao obter bilhetes');
  return res.json();
}

/** Exclui uma ficha da memória e da base de dados. */
export async function deleteTicket(id: string): Promise<{
  deleted: boolean;
  id: string;
  all: BetSlip[];
  stock: TicketStockStatus;
}> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Falha ao excluir a ficha');
  }
  return data;
}

/** Bilhetes de um motor específico (`local` = principal, `manual` ou `jev`). */
export async function fetchTicketsByEngine(engine: BetEngine): Promise<BetSlip[]> {
  const res = await fetch(`/api/tickets?engine=${encodeURIComponent(engine)}`);
  if (!res.ok) throw new Error('Falha ao obter bilhetes do motor');
  return res.json();
}

/** Estado do motor JEV remoto (configuração e modelo). */
export async function fetchJevStatus(): Promise<JevStatus> {
  const res = await fetch('/api/jev/status');
  if (!res.ok) throw new Error('Falha ao obter o estado do JEV');
  return res.json();
}

export async function fetchTicketStock(): Promise<TicketStockStatus> {
  const res = await fetch('/api/tickets/stock');
  if (!res.ok) throw new Error('Falha ao obter estoque de bilhetes');
  return res.json();
}

export async function fetchPremierBetStatus(): Promise<PremierBetStatus> {
  const res = await fetch('/api/premierbet/status');
  if (!res.ok) throw new Error('Falha ao obter estado da Premier Bet');
  return res.json();
}

export interface UploadSlipOptions {
  /** Valor em Kwanzas (AOA). */
  stake: number;
  dryRun?: boolean;
  force?: boolean;
}

export async function uploadSlip(
  slipId: string,
  options: UploadSlipOptions
): Promise<PremierBetUploadResult> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(slipId)}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Falha ao subir a ficha para a Premier Bet') as Error & {
      upload?: SlipUpload;
    };
    err.upload = data.upload;
    throw err;
  }
  return data as PremierBetUploadResult;
}

export async function fetchTipMarkets(): Promise<TipMarket[]> {
  const res = await fetch('/api/tips/markets');
  if (!res.ok) throw new Error('Falha ao carregar os tipos de tip');
  return res.json();
}

export async function generateTickets(
  scope: 'dia' | '2_3_dias' | 'longo',
  leagues?: string[],
  limit = 4,
  market?: string,
  engine: 'local' | 'manual' = 'local'
): Promise<{
  generated: BetSlip[];
  all: BetSlip[];
  stock?: TicketStockStatus;
  message?: string;
}> {
  const res = await fetch('/api/tickets/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, leagues, limit, market: market || undefined, engine }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao gerar bilhetes');
  }
  return res.json();
}

/** Gera fichas remotas com o motor JEV. */
export async function generateJevTickets(
  scope: 'dia' | '2_3_dias' | 'longo',
  limit = 4,
  leagues?: string[]
): Promise<{
  generated: BetSlip[];
  all: BetSlip[];
  stock?: TicketStockStatus;
  message?: string;
}> {
  const res = await fetch('/api/jev/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, limit, leagues }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Erro ao gerar fichas com o JEV');
  }
  return data;
}

export async function createCustomSlip(
  scope: 'dia' | '2_3_dias' | 'longo',
  legs: Array<{ matchId: string; market: string }>,
  tier?: SlipTier
): Promise<{ slip: BetSlip; all: BetSlip[] }> {
  const res = await fetch('/api/tickets/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, legs, tier }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Erro ao criar a ficha manual');
  }
  return data as { slip: BetSlip; all: BetSlip[] };
}

export async function fetchProgressions(): Promise<Progression[]> {
  const res = await fetch('/api/progressions');
  if (!res.ok) throw new Error('Falha ao carregar as progressões');
  return res.json();
}

export async function createProgression(
  input: CreateProgressionInput
): Promise<Progression> {
  const res = await fetch('/api/progressions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha ao criar a progressão');
  return data as Progression;
}

export async function playProgression(id: string): Promise<Progression> {
  const res = await fetch(`/api/progressions/${encodeURIComponent(id)}/play`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha ao iniciar a progressão');
  return data as Progression;
}

export async function stopProgression(id: string): Promise<Progression> {
  const res = await fetch(`/api/progressions/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha ao parar a progressão');
  return data as Progression;
}

export async function deleteProgression(id: string): Promise<void> {
  const res = await fetch(`/api/progressions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha ao excluir a progressão');
}

export async function resolveMatch(
  matchId?: string,
  resolveNextPending = false
): Promise<{ resolved: MatchItem[]; allSlips: BetSlip[] }> {
  const res = await fetch('/api/matches/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId, resolveNextPending }),
  });
  if (!res.ok) throw new Error('Erro ao resolver partida');
  return res.json();
}

export async function resetMatches(): Promise<{ matches: MatchItem[]; slips: BetSlip[] }> {
  const res = await fetch('/api/matches/reset', { method: 'POST' });
  if (!res.ok) throw new Error('Erro ao reiniciar partidas');
  return res.json();
}

export async function analyzeMatchWithAi(matchId: string): Promise<AiMatchAnalysis> {
  const res = await fetch('/api/ai/analyze-match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro na análise com IA');
  }
  return res.json();
}

export async function generateSmartSlipWithAi(preference?: string): Promise<{ slip: BetSlip; allSlips: BetSlip[] }> {
  const res = await fetch('/api/ai/generate-smart-slip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preference }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao gerar bilhete com IA');
  }
  return res.json();
}
