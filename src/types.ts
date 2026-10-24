export interface MatchOdds {
  home: number;
  draw: number;
  away: number;
  over15?: number;
  over25: number;
  over35?: number;
  under25: number;
  under35?: number;
  btts_yes: number;
  btts_no: number;
  /** Mercados com odds reais; os restantes são apenas estimativas. */
  realMarkets?: MarketType[];
  double_chance_1x?: number;
  double_chance_x2?: number;
  double_chance_12?: number;
  dnb_home?: number;
  dnb_away?: number;
}

export type MarketType =
  | 'home'
  | 'draw'
  | 'away'
  | 'over15'
  | 'over25'
  | 'over35'
  | 'under25'
  | 'under35'
  | 'btts_yes'
  | 'btts_no'
  | 'double_chance_1x'
  | 'double_chance_x2'
  | 'double_chance_12'
  | 'dnb_home'
  | 'dnb_away';

export interface MatchTip {
  market: string;
  label: string;
  /** `null` quando o mercado não tem odd real disponível. */
  odds: number | null;
  prob: number;
}

export interface TipMarket {
  market: string;
  label: string;
}

/** Seleção guardada no carrinho para montar uma ficha manual. */
export interface CartLeg {
  matchId: string;
  market: string;
  label: string;
  odds: number;
  prob: number;
  home: string;
  away: string;
  league: string;
}

export interface MatchResult {
  homeScore?: number;
  awayScore?: number;
  outcome1x2: 'home' | 'draw' | 'away';
  outcomeOU: 'over25' | 'under25';
  outcomeBtts: 'btts_yes' | 'btts_no';
  tipWon: boolean;
}

export interface TeamH2H {
  homeWins: number;
  draws: number;
  awayWins: number;
  avgGoals: number;
  bothScoredPct: number;
  lastEncounters: Array<{
    date: string;
    score: string;
    winner: 'home' | 'away' | 'draw';
  }>;
}

export interface TeamForm {
  recentForm: ('W' | 'D' | 'L')[];
  goalsScoredAvg5: number;
  goalsConcededAvg5: number;
  cleanSheetPct: number;
}

export interface MatchContext {
  h2h: TeamH2H;
  homeForm: TeamForm;
  awayForm: TeamForm;
  importance: 'normal' | 'alta' | 'derby' | 'decisiva';
  restDaysHome: number;
  restDaysAway: number;
}

export interface MatchItem {
  id: string;
  league: string;
  competitionId?: string | null;
  home: string;
  away: string;
  time: string;
  dateStr?: string;
  daysFromNow: number;
  kickoffAt: number;
  kickoffInSeconds: number;
  odds: MatchOdds;
  tip: MatchTip;
  /** Todos os mercados calculados para o jogo (inclui os sem odd real). */
  tips?: MatchTip[];
  /** Tip alternativa de odd alta, calculada pelo motor para a ficha Maluca. */
  highRiskTip?: MatchTip;
  context: MatchContext | null;
  jevInference?: {
    calibratedProb: number;
    expectedValueEdge: number;
    recommendedMarket: MarketType;
    riskTier: SlipTier;
    latencyMs: number;
    jevModelVersion: string;
  };
  status: 'pending' | 'live' | 'resolved';
  result: MatchResult | null;
  sourceProvider?: string;
}

export type SlipScope = 'dia' | '2_3_dias' | 'longo' | 'historico';
export type SlipTier = 'segura' | 'moderada' | 'ousada' | 'maluca';

/** Estado da última tentativa de subir a ficha para a Premier Bet. */
export type SlipUploadStatus = 'in_progress' | 'placed' | 'dry_run' | 'failed' | 'unknown';

export interface SlipUpload {
  slipId: string;
  status: SlipUploadStatus;
  /** Valor apostado em Kwanzas (AOA). */
  stake: number;
  betId?: string;
  message?: string;
  /** Timestamp (ms) da última tentativa. */
  at: number;
}

export interface PremierBetStatus {
  configured: boolean;
  dryRun: boolean;
  headful: boolean;
  defaultStake: number;
  maxStake: number;
  minStake: number;
  scriptExists: boolean;
}

export interface PremierBetUploadResult {
  ok: boolean;
  placed: boolean;
  dryRun: boolean;
  loggedIn: boolean;
  filled: number;
  totalOdds: number | null;
  stake: number;
  betId?: string | null;
  message: string;
  detail?: string;
  unknown?: boolean;
  screenshot?: string | null;
  durationMs?: number;
  upload?: SlipUpload;
}

export interface BetSlip {
  id: string;
  scope: 'dia' | '2_3_dias' | 'longo';
  tier: SlipTier;
  color: string;
  legs: MatchItem[];
  combinedOdds: number;
  combinedProb: number;
  expiresAt: number; // timestamp do 1º jogo a iniciar
  status: 'pendente' | 'ganhou' | 'perdeu' | 'expirado';
  createdAt: number;
  resolvedAt: number | null;
  customTitle?: string;
  rationale?: string;
  isAiGenerated?: boolean;
  /** Data-calendário de Angola (YYYY-MM-DD) em que a ficha foi criada. */
  dayKey?: string;
  /** Preenchido pela API: última tentativa de subir para a Premier Bet. */
  upload?: SlipUpload | null;
}

export type HistoryFilter = 'andamento' | 'ganhas' | 'perdidas' | 'vencidas';

export interface TicketStockScope {
  scope: 'dia' | '2_3_dias' | 'longo';
  pending: number;
  quota: number;
  missing: number;
  maxPending: number;
}

export interface TicketStockStatus {
  dayKey: string;
  timezone: string;
  dailyHour: number;
  lastDailyRun: string | null;
  lastTickAt: string | null;
  generating: boolean;
  expiryGraceHours: number;
  stocks: TicketStockScope[];
}

export interface MarketProviderStatus {
  provider: 'the-odds-api' | 'football-data' | 'custom-api' | 'simulated-engine';
  isExternalApi: boolean;
  apiKeyConfigured: boolean;
  providerName: string;
  endpointUrl?: string;
  lastUpdated: string;
  totalMatches: number;
  activeLeagues: string[];
  message: string;
  rateLimitInfo?: {
    requestsUsed?: number;
    requestsRemaining?: number;
  };
}

export interface JevMetrics {
  totalInferences: number;
  avgCalibratedProb: number;
  avgEdgeEV: number;
  activeTierBreakdown: {
    segura: number;
    moderada: number;
    ousada: number;
    maluca: number;
  };
  topMarkets: Array<{ market: string; count: number; percentage: number }>;
  lastInferenceAt: string;
}

export interface JevEngineStatus {
  isRemoteKeyConfigured: boolean;
  provider?: string;
  modelVersion: string;
  architecture: string;
  latencyMs: number;
  supportedScopes: string[];
  strictlyEnforced?: boolean;
  metrics?: JevMetrics;
}

export interface BackendStatus {
  status: string;
  serverTime: string;
  provider: MarketProviderStatus;
  jevEngine?: JevEngineStatus;
  aiEngine: {
    hasGeminiApiKey: boolean;
    model: string;
    features: string[];
  };
  stats: {
    totalMatches: number;
    totalSlips: number;
  };
  tickets?: TicketStockStatus;
}

export interface AiMatchAnalysis {
  matchId: string;
  tacticalSummary: string;
  keyFactors: string[];
  recommendedMarket: string;
  confidenceScore: number;
  riskLevel: 'Baixo' | 'Moderado' | 'Alto';
  impliedProbValue: string;
}
