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
  /** true quando DNB empatou (push/reembolso — contado como acerto). */
  pushed?: boolean;
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
  home: string;
  away: string;
  time: string;
  dateStr?: string;
  daysFromNow: number;
  kickoffAt: number; // timestamp in ms
  kickoffInSeconds: number;
  odds: MatchOdds;
  tip: MatchTip;
  context: MatchContext | null;
  /**
   * Scout COMPLETO do AiScore (match/history decodificado): home_form,
   * away_form, h2h, h2h_summary, home_trend, away_trend, market_hints.
   * É daqui que o motor local tira todas as variáveis — o `context`
   * acima é só o resumo. Anexado por aiscoreService.enrichMatches.
   */
  scout?: any;
  /** Extras opcionais: { goal_distributions, home_trend_sc, away_trend_sc, h2h_stats }. */
  advanced?: any;
  /** Classificação (bridge tables): { comp_id, season_id, tables[] }. */
  tables?: any;
  /** Escalações (bridge lineups): confirmed, formations, ratings, desfalques. */
  lineups?: any;
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

export type SlipScope = 'dia' | '2_3_dias' | 'longo';
export type SlipTier = 'segura' | 'moderada' | 'ousada';

export interface BetSlip {
  id: string;
  scope: SlipScope;
  tier: SlipTier;
  color: string;
  legs: MatchItem[];
  combinedOdds: number;
  combinedProb: number;
  expiresAt: number; // timestamp em ms do início do primeiro jogo do bilhete
  status: 'pendente' | 'ganhou' | 'perdeu';
  createdAt: number;
  resolvedAt: number | null;
  customTitle?: string;
  rationale?: string;
  isAiGenerated?: boolean;
}

export interface MarketProviderStatus {
  provider: 'the-odds-api' | 'football-data' | 'custom-api' | 'simulated-engine' | 'aiscore';
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
  strictlyEnforced: boolean;
  metrics?: JevMetrics;
}
