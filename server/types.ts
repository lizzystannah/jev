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
  /**
   * Mercados cujas odds vieram de uma casa/fornecedor real. Mercados fora
   * desta lista sÃ£o apenas estimativas e nunca entram em fichas.
   */
  realMarkets?: MarketType[];
  double_chance_1x?: number;
  double_chance_x2?: number;
  double_chance_12?: number;
  dnb_home?: number;
  dnb_away?: number;
  /** Odds reais das tips compostas (mesmo jogo, duas condicoes). */
  comboOdds?: Partial<Record<CompostaMarket, number>>;
}

export type SimpleMarket =
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

export type ResultOutcome = 'home' | 'draw' | 'away';
export type DcOutcome =
  | 'double_chance_1x'
  | 'double_chance_x2'
  | 'double_chance_12';
export type BttsOutcome = 'btts_yes' | 'btts_no';
export type TotalLine =
  | 'over15'
  | 'over25'
  | 'over35'
  | 'over45'
  | 'under15'
  | 'under25'
  | 'under35'
  | 'under45';

/**
 * Tip composta: duas condicoes no MESMO jogo (resultado/DC/BTTS + linha de
 * golos, ou resultado/DC + BTTS). A odd tem de vir da Premier Bet.
 */
export type CompostaMarket =
  | `${ResultOutcome}_${TotalLine}`
  | `${DcOutcome}_${TotalLine}`
  | `${BttsOutcome}_${TotalLine}`
  | `${ResultOutcome}_${BttsOutcome}`
  | `${DcOutcome}_${BttsOutcome}`;

export type MarketType = SimpleMarket | CompostaMarket;

export interface MatchTip {
  market: MarketType;
  label: string;
  odds: number;
  prob: number;
}

/**
 * Tip calculada para um mercado especÃ­fico. `odds` Ã© null quando o mercado
 * nÃ£o tem preÃ§o real (nunca se inventa uma odd para preencher).
 */
export interface TipOption {
  market: MarketType;
  label: string;
  odds: number | null;
  prob: number; // 0..100
}

export interface MatchResult {
  homeScore?: number;
  awayScore?: number;
  outcome1x2: 'home' | 'draw' | 'away';
  outcomeOU: 'over25' | 'under25';
  outcomeBtts: 'btts_yes' | 'btts_no';
  tipWon: boolean;
  /** true quando DNB empatou (push/reembolso â€” contado como acerto). */
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
  competitionId?: string | null;
  home: string;
  away: string;
  time: string;
  dateStr?: string;
  daysFromNow: number;
  kickoffAt: number; // timestamp in ms
  kickoffInSeconds: number;
  odds: MatchOdds;
  tip: MatchTip;
  /** Todas as tips calculadas para o jogo (com odds reais ou null). */
  tips?: TipOption[];
  /**
   * CalibraÃ§Ã£o persistida: probabilidades/tips calculadas para a assinatura
   * de odds atual. Sobrevive a restart/redeploy (cache em disco/DB) e sÃ³ Ã©
   * recalculada quando as odds mudam.
   */
  calibration?: {
    tips: TipOption[];
    recommendedMarket: MarketType;
    marketLabel: string;
    calibratedProb: number;
    expectedValueEdge: number;
    highRiskTip?: MatchTip;
    oddsHash: string;
    at: number;
    /** DecisÃ£o do JEV persistida (reutilizada se as odds nÃ£o mudarem). */
    jevPick?: {
      market: MarketType;
      confidence: number;
      reason: string;
      at: number;
    };
  };
  /**
   * Tip alternativa de odd alta, calculada pelo mesmo motor a partir dos
   * mercados reais. Ã‰ usada apenas na ficha Maluca; nÃ£o substitui a tip
   * principal e nunca contÃ©m odds sintÃ©ticas.
   */
  highRiskTip?: MatchTip;
  context: MatchContext | null;
  /**
   * Scout COMPLETO do AiScore (match/history decodificado): home_form,
   * away_form, h2h, h2h_summary, home_trend, away_trend, market_hints.
   * Ã‰ daqui que o motor local tira todas as variÃ¡veis â€” o `context`
   * acima Ã© sÃ³ o resumo. Anexado por aiscoreService.enrichMatches.
   */
  scout?: any;
  /** Extras opcionais: { goal_distributions, home_trend_sc, away_trend_sc, h2h_stats }. */
  advanced?: any;
  /** ClassificaÃ§Ã£o (bridge tables): { comp_id, season_id, tables[] }. */
  tables?: any;
  /** EscalaÃ§Ãµes (bridge lineups): confirmed, formations, ratings, desfalques. */
  lineups?: any;
  jevInference?: {
    calibratedProb: number;
    expectedValueEdge: number;
    recommendedMarket: MarketType;
    riskTier: SlipTier;
    latencyMs: number;
    jevModelVersion: string;
    /** Confiança da escolha do JEV (0-100), quando a tip veio do JEV. */
    jevConfidence?: number;
  };
  status: 'pending' | 'live' | 'resolved';
  result: MatchResult | null;
  sourceProvider?: string;
  /** Ja se tentou obter odds compostas na Premier Bet para este jogo. */
  compostaOddsChecked?: boolean;
}

export type SlipScope = 'dia' | '2_3_dias' | 'longo';
export type SlipTier = 'segura' | 'moderada' | 'ousada' | 'maluca' | 'compostas';
/** Motor que produziu a ficha (principal local, JEV, manual ou progressão). */
export type SlipEngine = 'local' | 'manual' | 'jev' | 'progression';

/** Modo de gestão de banca de uma progressão. */
export type ProgressionMode = 'fixo' | 'total' | 'metade' | 'soros';
/** `ativa` gera/coloca automaticamente; `pausada` espera pelo Play. */
export type ProgressionStatus = 'ativa' | 'pausada' | 'erro';
export type ProgressionRunStatus = 'pendente' | 'ganhou' | 'perdeu' | 'expirado' | 'falhou';

/** Uma ficha gerada por uma progressão (um nível). */
export interface ProgressionRun {
  level: number;
  slipId: string;
  stake: number;
  odds: number;
  status: ProgressionRunStatus;
  /** Lucro/prejuízo em Kwanzas quando resolvida (null enquanto pendente). */
  profit: number | null;
  /** ID devolvido pela Premier Bet quando a aposta é colocada. */
  betId?: string;
  message?: string;
  createdAt: number;
  resolvedAt?: number | null;
}

/** Configuração persistida de uma automação de progressão. */
export interface Progression {
  id: string;
  name: string;
  /** Motor que escolhe as tips: principal (local) ou JEV. */
  engine: 'local' | 'jev';
  tier: Exclude<SlipTier, 'maluca'>;
  scope: SlipScope;
  mode: ProgressionMode;
  /** Valor base de cada ficha, em Kwanzas. */
  baseStake: number;
  /** Percentagem do lucro anterior reinvestida (0-100). */
  reinvestPct: number;
  /** Nº de níveis do ciclo; ao chegar ao fim, recomeça no nível 1. */
  maxLevel: number;
  targetOddsMin: number;
  targetOddsMax: number;
  status: ProgressionStatus;
  currentLevel: number;
  /** Valor que será usado na próxima ficha. */
  currentStake: number;
  lastProfit: number;
  totalProfit: number;
  cycles: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | null;
  lastError?: string | null;
  runs: ProgressionRun[];
}

/** Estado da Ãºltima tentativa de subir a ficha para a Premier Bet. */
export type SlipUploadStatus = 'in_progress' | 'placed' | 'dry_run' | 'failed' | 'unknown';

export interface SlipUpload {
  slipId: string;
  status: SlipUploadStatus;
  /** Valor apostado em Kwanzas (AOA). */
  stake: number;
  betId?: string;
  message?: string;
  /** Timestamp (ms) da Ãºltima tentativa. */
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
  /** Quando sÃ³ parte das pernas foi localizada na Premier Bet. */
  partial?: boolean;
  expected_legs?: number;
  placed_legs?: Array<{ home?: string; away?: string; market?: string }>;
  resolved?: {
    n_legs?: number;
    total_odds?: number | null;
    report?: Array<{
      home?: string;
      away?: string;
      market?: string;
      status?: string;
      pb_odd?: number | string | null;
    }>;
  } | null;
}

export interface BetSlip {
  id: string;
  scope: SlipScope;
  tier: SlipTier;
  /** Motor que gerou a ficha. Fichas antigas sem campo contam como 'local'. */
  engine?: SlipEngine;
  color: string;
  legs: MatchItem[];
  combinedOdds: number;
  combinedProb: number;
  expiresAt: number; // timestamp em ms do inÃ­cio do primeiro jogo do bilhete
  status: 'pendente' | 'ganhou' | 'perdeu' | 'expirado';
  createdAt: number;
  resolvedAt: number | null;
  customTitle?: string;
  rationale?: string;
  isAiGenerated?: boolean;
  /** Data-calendÃ¡rio de Angola (YYYY-MM-DD) em que a ficha foi criada. */
  dayKey?: string;
  /** Progressão que criou esta ficha (quando engine === 'progression'). */
  progressionId?: string;
  progressionLevel?: number;
  /** Preenchido pela API: Ãºltima tentativa de subir para a Premier Bet. */
  upload?: SlipUpload | null;
}

/** Cota/estoque de fichas por horizonte temporal. */
export interface TicketStockScope {
  scope: SlipScope;
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
    maluca: number;
    compostas: number;
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

