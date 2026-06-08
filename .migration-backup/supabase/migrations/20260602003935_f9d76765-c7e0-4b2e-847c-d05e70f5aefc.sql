CREATE TABLE public.v75_micro_reversal_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  direction TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  strength TEXT NOT NULL,
  recommended_duration TEXT,
  entry_price NUMERIC(14,4) NOT NULL,
  level_price NUMERIC(14,4),
  suggested_sl NUMERIC(14,4),
  suggested_tp1 NUMERIC(14,4),
  suggested_tp2 NUMERIC(14,4),
  confluence_factors TEXT[] DEFAULT '{}',
  cross_confirmed BOOLEAN DEFAULT false,
  counter_trend BOOLEAN DEFAULT false,
  existing_analyzer_direction TEXT,
  outcome TEXT DEFAULT 'PENDING' CHECK (outcome IN ('WIN','LOSS','PENDING')),
  exit_price NUMERIC(14,4),
  ema9 NUMERIC(14,4),
  ema21 NUMERIC(14,4),
  bb_upper NUMERIC(14,4),
  bb_lower NUMERIC(14,4),
  atr NUMERIC(14,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.v75_micro_reversal_signals TO anon, authenticated;
GRANT ALL ON public.v75_micro_reversal_signals TO service_role;

ALTER TABLE public.v75_micro_reversal_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "v75_mr_public_read" ON public.v75_micro_reversal_signals
  FOR SELECT USING (true);
CREATE POLICY "v75_mr_public_insert" ON public.v75_micro_reversal_signals
  FOR INSERT WITH CHECK (true);
CREATE POLICY "v75_mr_public_update" ON public.v75_micro_reversal_signals
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE INDEX idx_v75_mr_timestamp ON public.v75_micro_reversal_signals(timestamp DESC);
CREATE INDEX idx_v75_mr_outcome ON public.v75_micro_reversal_signals(outcome);