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
  market: MarketType;
  label: string;
  odds: number;
  prob: number;
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
export type SlipTier = 'segura' | 'moderada' | 'ousada';

export interface BetSlip {
  id: string;
  scope: 'dia' | '2_3_dias' | 'longo';
  tier: SlipTier;
  color: string;
  legs: MatchItem[];
  combinedOdds: number;
  combinedProb: number;
  expiresAt: number; // timestamp do 1º jogo a iniciar
  status: 'pendente' | 'ganhou' | 'perdeu';
  createdAt: number;
  resolvedAt: number | null;
  customTitle?: string;
  rationale?: string;
  isAiGenerated?: boolean;
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
