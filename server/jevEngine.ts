export interface JevTipCandidate {
  market: string;
  label: string;
  prob: number;
  odds: number | null;
}

export interface JevCandidate {
  id: string;
  home: string;
  away: string;
  league: string;
  kickoff: string; // ISO ou "YYYY-MM-DD HH:mm"
  odds: {
    home?: number;
    draw?: number;
    away?: number;
    over25?: number;
    under25?: number;
    btts_yes?: number;
    btts_no?: number;
  };
  tips: JevTipCandidate[]; // apenas mercados com odds real (odds != null), no máximo 6, ordenados por prob desc
}

export interface JevPick {
  market: string;
  confidence: number;
  reason: string;
}

type JevProvider = 'jev' | 'openrouter' | 'openai';

interface JevConfig {
  apiKey: string | null;
  endpoint: string;
  model: string;
  provider: JevProvider;
  timeoutMs: number;
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 30;
const MAX_REASON_LENGTH = 200;
const MAX_TIPS_PER_GAME = 6;

const SYSTEM_PROMPT =
  'És um analista sénior de apostas desportivas. Recebes, por jogo, apenas os mercados candidatos calculados pelo motor local, com a respetiva probabilidade e a odd real. Deves escolher no máximo um mercado por jogo, exclusivamente a partir dos tips fornecidos. Nunca inventes mercados nem odds. Podes omitir qualquer jogo se nenhum candidato for convincente. Responde sempre com JSON estrito, sem markdown nem texto adicional.';

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveProvider(endpoint: string): JevProvider {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
    if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai';
  } catch {
    // Endpoint inválido: fica classificado como JEV genérico.
  }
  return 'jev';
}

function resolveConfig(): JevConfig {
  const openRouterKey = readEnv('OPENROUTER_API_KEY');
  const apiKey = readEnv('JEV_API_KEY') ?? openRouterKey ?? readEnv('OPENAI_API_KEY') ?? null;
  const endpoint =
    readEnv('JEV_API_URL') ??
    (openRouterKey
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions');
  const model = readEnv('JEV_MODEL') ?? readEnv('OPENROUTER_MODEL') ?? 'openrouter/free';
  const provider = resolveProvider(endpoint);

  const rawTimeout = Number(readEnv('JEV_TIMEOUT_MS'));
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    const appUrl = readEnv('APP_URL');
    if (appUrl) headers['HTTP-Referer'] = appUrl;
    headers['X-Title'] = 'Bilheteria JEV';
  }

  return { apiKey, endpoint, model, provider, timeoutMs, headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function effectiveTips(candidate: JevCandidate): JevTipCandidate[] {
  return candidate.tips
    .filter((tip) => tip.odds !== null && Number.isFinite(tip.odds))
    .slice()
    .sort((a, b) => b.prob - a.prob)
    .slice(0, MAX_TIPS_PER_GAME);
}

function resolveTimeout(override: number | undefined, fallback: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  return fallback;
}

function buildPrompt(batch: JevCandidate[]): string {
  const games = batch.map((candidate) => ({
    id: candidate.id,
    home: candidate.home,
    away: candidate.away,
    league: candidate.league,
    kickoff: candidate.kickoff,
    tips: effectiveTips(candidate),
  }));

  return `Analisa os seguintes jogos de futebol e escolhe o tip mais convincente de cada jogo.

Regras:
- Escolhe no máximo um mercado por jogo.
- Usa apenas o campo "market" exatamente como aparece na lista de tips do respetivo jogo.
- Nunca inventes mercados nem odds.
- Podes omitir um jogo se nenhum candidato for convincente.
- "confidence" deve ser um número inteiro entre 0 e 100.
- "reason" deve ser uma justificação curta, com no máximo 200 caracteres.
- Responde apenas com JSON estrito, sem blocos de código nem texto adicional.

Jogos (cada tip inclui a probabilidade do modelo local e a odd real):
${JSON.stringify(games, null, 2)}

Formato de resposta:
{"picks":[{"id":"<id do jogo>","market":"<market>","confidence":0,"reason":"<justificação curta>"}]}`;
}

async function callCompletion(
  config: JevConfig,
  prompt: string,
  timeoutMs: number,
  strictJsonInstruction: boolean
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const userContent = strictJsonInstruction
      ? `${prompt}\n\nResponda apenas JSON válido.`
      : prompt;

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      throw new Error(
        `JEV: falha HTTP ${response.status}${statusText}: ${body.slice(0, 500)}`
      );
    }

    const data: unknown = await response.json().catch(() => null);
    const content = extractContent(data);
    if (!content) {
      throw new Error('JEV: resposta da API sem conteúdo.');
    }
    return content;
  } catch (error) {
    if (timedOut) {
      throw new Error(`JEV: tempo limite de ${timeoutMs}ms excedido.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;

  const message = firstChoice.message;
  if (!isRecord(message)) return null;

  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? text : null;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    return text ? text : null;
  }

  return null;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function parsePicksPayload(text: string): unknown[] | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const extracted = extractFirstJsonObject(trimmed);
  if (extracted && extracted !== trimmed) candidates.push(extracted);

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && Array.isArray(parsed.picks)) {
        return parsed.picks;
      }
    } catch {
      // Tenta o próximo candidato.
    }
  }

  return null;
}

function validatePicks(
  rawPicks: unknown[],
  candidates: JevCandidate[]
): Map<string, JevPick> {
  const tipsByGame = new Map<string, Map<string, JevTipCandidate>>();
  for (const candidate of candidates) {
    const tips = new Map<string, JevTipCandidate>();
    for (const tip of effectiveTips(candidate)) {
      tips.set(tip.market, tip);
    }
    tipsByGame.set(candidate.id, tips);
  }

  const picks = new Map<string, JevPick>();

  for (const rawPick of rawPicks) {
    if (!isRecord(rawPick)) continue;

    const id = typeof rawPick.id === 'string' ? rawPick.id.trim() : '';
    const tips = tipsByGame.get(id);
    if (!tips) continue;
    if (picks.has(id)) continue;

    const market = typeof rawPick.market === 'string' ? rawPick.market.trim() : '';
    if (!market) continue;

    const tip = tips.get(market);
    if (!tip || tip.odds === null) continue;

    const rawConfidence =
      typeof rawPick.confidence === 'number'
        ? rawPick.confidence
        : Number(rawPick.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
      : 0;

    const rawReason = typeof rawPick.reason === 'string' ? rawPick.reason.trim() : '';
    const reason = rawReason.slice(0, MAX_REASON_LENGTH);

    picks.set(id, { market, confidence, reason });
  }

  return picks;
}

async function requestBatchPicks(
  config: JevConfig,
  batch: JevCandidate[],
  timeoutMs: number
): Promise<Map<string, JevPick>> {
  const prompt = buildPrompt(batch);

  const firstText = await callCompletion(config, prompt, timeoutMs, false);
  let rawPicks = parsePicksPayload(firstText);

  if (!rawPicks) {
    const retryText = await callCompletion(config, prompt, timeoutMs, true);
    rawPicks = parsePicksPayload(retryText);
  }

  if (!rawPicks) {
    throw new Error(
      'JEV: resposta inválida da API após nova tentativa. Esperado JSON estrito com a chave "picks".'
    );
  }

  return validatePicks(rawPicks, batch);
}

export function jevStatus(): {
  configured: boolean;
  model: string;
  provider: 'jev' | 'openrouter' | 'openai';
  endpoint: string;
} {
  const config = resolveConfig();
  return {
    configured: Boolean(config.apiKey),
    model: config.model,
    provider: config.provider,
    endpoint: config.endpoint,
  };
}

export async function jevChooseMarkets(
  candidates: JevCandidate[],
  opts?: { timeoutMs?: number }
): Promise<Map<string, JevPick>> {
  const config = resolveConfig();
  if (!config.apiKey) {
    throw new Error(
      'JEV não configurado: defina JEV_API_KEY (ou OPENROUTER_API_KEY) na env.'
    );
  }

  const timeoutMs = resolveTimeout(opts?.timeoutMs, config.timeoutMs);
  const usable = candidates.filter((candidate) => effectiveTips(candidate).length > 0);
  const picks = new Map<string, JevPick>();

  for (let index = 0; index < usable.length; index += BATCH_SIZE) {
    const batch = usable.slice(index, index + BATCH_SIZE);
    const batchPicks = await requestBatchPicks(config, batch, timeoutMs);
    for (const [id, pick] of batchPicks) {
      if (!picks.has(id)) picks.set(id, pick);
    }
  }

  return picks;
}
