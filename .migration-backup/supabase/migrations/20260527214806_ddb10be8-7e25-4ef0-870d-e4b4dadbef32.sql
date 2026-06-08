
CREATE TABLE public.v75_segment_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  date_str TEXT NOT NULL,
  time_str TEXT NOT NULL,
  open_price DECIMAL(12,2) NOT NULL,
  close_price DECIMAL(12,2) NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('RISE','FALL','FLAT')),
  point_move DECIMAL(10,2) NOT NULL,
  score INTEGER NOT NULL,
  adjusted_score INTEGER,
  rsi DECIMAL(6,2),
  stoch_k DECIMAL(6,2),
  stoch_d DECIMAL(6,2),
  macd_histogram DECIMAL(12,4),
  williams_r DECIMAL(6,2),
  cci DECIMAL(8,2),
  bb_position DECIMAL(6,4),
  bb_width DECIMAL(8,4),
  atr DECIMAL(12,2),
  relative_atr DECIMAL(8,6),
  ema9 DECIMAL(12,2),
  ema21 DECIMAL(12,2),
  ema50 DECIMAL(12,2),
  ema200 DECIMAL(12,2),
  ema_alignment TEXT,
  has_active_bob BOOLEAN DEFAULT false,
  has_active_beob BOOLEAN DEFAULT false,
  ob_timeframe TEXT DEFAULT 'NONE',
  has_fvg_bull BOOLEAN DEFAULT false,
  has_fvg_bear BOOLEAN DEFAULT false,
  choch_detected TEXT DEFAULT 'NONE',
  liquidity_sweep TEXT DEFAULT 'NONE',
  h4_bias TEXT DEFAULT 'NEUTRAL',
  h1_bias TEXT DEFAULT 'NEUTRAL',
  top_down_alignment TEXT DEFAULT 'MIXED',
  candle_pattern TEXT DEFAULT 'NONE',
  structure TEXT DEFAULT 'NEUTRAL',
  rsi_divergence TEXT DEFAULT 'NONE',
  macd_divergence TEXT DEFAULT 'NONE',
  hour_of_day INTEGER,
  day_of_week INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v75_segment_records TO anon, authenticated;
GRANT ALL ON public.v75_segment_records TO service_role;
ALTER TABLE public.v75_segment_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v75_seg_all" ON public.v75_segment_records FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE public.v75_condition_stats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  condition_name TEXT UNIQUE NOT NULL,
  rise_wins INTEGER DEFAULT 0,
  fall_wins INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  accuracy DECIMAL(5,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v75_condition_stats TO anon, authenticated;
GRANT ALL ON public.v75_condition_stats TO service_role;
ALTER TABLE public.v75_condition_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v75_cond_all" ON public.v75_condition_stats FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE public.v75_signal_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('RISE','FALL')),
  strength TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  score INTEGER NOT NULL,
  adjusted_score INTEGER,
  duration_minutes INTEGER NOT NULL,
  entry_price DECIMAL(12,2),
  exit_price DECIMAL(12,2),
  outcome TEXT CHECK (outcome IN ('WIN','LOSS','PENDING')) DEFAULT 'PENDING',
  choch_present BOOLEAN DEFAULT false,
  sweep_present BOOLEAN DEFAULT false,
  ob_timeframe TEXT DEFAULT 'NONE',
  h4_bias TEXT,
  h1_bias TEXT,
  pattern_match_rate DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.v75_signal_history TO anon, authenticated;
GRANT ALL ON public.v75_signal_history TO service_role;
ALTER TABLE public.v75_signal_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v75_hist_all" ON public.v75_signal_history FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_v75_seg_ts ON public.v75_segment_records (timestamp DESC);
CREATE INDEX idx_v75_hist_ts ON public.v75_signal_history (timestamp DESC);
