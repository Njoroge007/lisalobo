export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      v75_condition_stats: {
        Row: {
          accuracy: number | null
          condition_name: string
          fall_wins: number | null
          id: string
          rise_wins: number | null
          total: number | null
          updated_at: string | null
          weight_multiplier: number
        }
        Insert: {
          accuracy?: number | null
          condition_name: string
          fall_wins?: number | null
          id?: string
          rise_wins?: number | null
          total?: number | null
          updated_at?: string | null
          weight_multiplier?: number
        }
        Update: {
          accuracy?: number | null
          condition_name?: string
          fall_wins?: number | null
          id?: string
          rise_wins?: number | null
          total?: number | null
          updated_at?: string | null
          weight_multiplier?: number
        }
        Relationships: []
      }
      v75_micro_reversal_signals: {
        Row: {
          atr: number | null
          bb_lower: number | null
          bb_upper: number | null
          confidence: number
          confluence_factors: string[] | null
          counter_trend: boolean | null
          created_at: string
          cross_confirmed: boolean | null
          direction: string
          ema21: number | null
          ema9: number | null
          entry_price: number
          existing_analyzer_direction: string | null
          exit_price: number | null
          id: string
          level_price: number | null
          outcome: string | null
          pattern_type: string
          recommended_duration: string | null
          strength: string
          suggested_sl: number | null
          suggested_tp1: number | null
          suggested_tp2: number | null
          timestamp: number
        }
        Insert: {
          atr?: number | null
          bb_lower?: number | null
          bb_upper?: number | null
          confidence: number
          confluence_factors?: string[] | null
          counter_trend?: boolean | null
          created_at?: string
          cross_confirmed?: boolean | null
          direction: string
          ema21?: number | null
          ema9?: number | null
          entry_price: number
          existing_analyzer_direction?: string | null
          exit_price?: number | null
          id?: string
          level_price?: number | null
          outcome?: string | null
          pattern_type: string
          recommended_duration?: string | null
          strength: string
          suggested_sl?: number | null
          suggested_tp1?: number | null
          suggested_tp2?: number | null
          timestamp: number
        }
        Update: {
          atr?: number | null
          bb_lower?: number | null
          bb_upper?: number | null
          confidence?: number
          confluence_factors?: string[] | null
          counter_trend?: boolean | null
          created_at?: string
          cross_confirmed?: boolean | null
          direction?: string
          ema21?: number | null
          ema9?: number | null
          entry_price?: number
          existing_analyzer_direction?: string | null
          exit_price?: number | null
          id?: string
          level_price?: number | null
          outcome?: string | null
          pattern_type?: string
          recommended_duration?: string | null
          strength?: string
          suggested_sl?: number | null
          suggested_tp1?: number | null
          suggested_tp2?: number | null
          timestamp?: number
        }
        Relationships: []
      }
      v75_segment_records: {
        Row: {
          adjusted_score: number | null
          atr: number | null
          bb_position: number | null
          bb_width: number | null
          candle_pattern: string | null
          cci: number | null
          choch_detected: string | null
          close_price: number
          created_at: string | null
          date_str: string
          day_of_week: number | null
          dominant_pattern: string | null
          ema_alignment: string | null
          ema200: number | null
          ema21: number | null
          ema50: number | null
          ema9: number | null
          h1_bias: string | null
          h4_bias: string | null
          has_active_beob: boolean | null
          has_active_bob: boolean | null
          has_fvg_bear: boolean | null
          has_fvg_bull: boolean | null
          hour_of_day: number | null
          id: string
          liquidity_sweep: string | null
          m15_bias: string | null
          macd_divergence: string | null
          macd_histogram: number | null
          ob_timeframe: string | null
          open_price: number
          outcome: string
          pattern_direction: string | null
          pattern_score: number | null
          point_move: number
          relative_atr: number | null
          rsi: number | null
          rsi_divergence: string | null
          score: number
          stoch_d: number | null
          stoch_k: number | null
          structure: string | null
          time_str: string
          timestamp: number
          top_down_alignment: string | null
          williams_r: number | null
        }
        Insert: {
          adjusted_score?: number | null
          atr?: number | null
          bb_position?: number | null
          bb_width?: number | null
          candle_pattern?: string | null
          cci?: number | null
          choch_detected?: string | null
          close_price: number
          created_at?: string | null
          date_str: string
          day_of_week?: number | null
          dominant_pattern?: string | null
          ema_alignment?: string | null
          ema200?: number | null
          ema21?: number | null
          ema50?: number | null
          ema9?: number | null
          h1_bias?: string | null
          h4_bias?: string | null
          has_active_beob?: boolean | null
          has_active_bob?: boolean | null
          has_fvg_bear?: boolean | null
          has_fvg_bull?: boolean | null
          hour_of_day?: number | null
          id?: string
          liquidity_sweep?: string | null
          m15_bias?: string | null
          macd_divergence?: string | null
          macd_histogram?: number | null
          ob_timeframe?: string | null
          open_price: number
          outcome: string
          pattern_direction?: string | null
          pattern_score?: number | null
          point_move: number
          relative_atr?: number | null
          rsi?: number | null
          rsi_divergence?: string | null
          score: number
          stoch_d?: number | null
          stoch_k?: number | null
          structure?: string | null
          time_str: string
          timestamp: number
          top_down_alignment?: string | null
          williams_r?: number | null
        }
        Update: {
          adjusted_score?: number | null
          atr?: number | null
          bb_position?: number | null
          bb_width?: number | null
          candle_pattern?: string | null
          cci?: number | null
          choch_detected?: string | null
          close_price?: number
          created_at?: string | null
          date_str?: string
          day_of_week?: number | null
          dominant_pattern?: string | null
          ema_alignment?: string | null
          ema200?: number | null
          ema21?: number | null
          ema50?: number | null
          ema9?: number | null
          h1_bias?: string | null
          h4_bias?: string | null
          has_active_beob?: boolean | null
          has_active_bob?: boolean | null
          has_fvg_bear?: boolean | null
          has_fvg_bull?: boolean | null
          hour_of_day?: number | null
          id?: string
          liquidity_sweep?: string | null
          m15_bias?: string | null
          macd_divergence?: string | null
          macd_histogram?: number | null
          ob_timeframe?: string | null
          open_price?: number
          outcome?: string
          pattern_direction?: string | null
          pattern_score?: number | null
          point_move?: number
          relative_atr?: number | null
          rsi?: number | null
          rsi_divergence?: string | null
          score?: number
          stoch_d?: number | null
          stoch_k?: number | null
          structure?: string | null
          time_str?: string
          timestamp?: number
          top_down_alignment?: string | null
          williams_r?: number | null
        }
        Relationships: []
      }
      v75_signal_history: {
        Row: {
          adjusted_score: number | null
          choch_present: boolean | null
          confidence: number
          created_at: string | null
          direction: string
          duration_minutes: number
          entry_price: number | null
          exit_price: number | null
          h1_bias: string | null
          h4_bias: string | null
          id: string
          ob_timeframe: string | null
          outcome: string | null
          pattern_match_rate: number | null
          score: number
          strength: string
          sweep_present: boolean | null
          timestamp: number
        }
        Insert: {
          adjusted_score?: number | null
          choch_present?: boolean | null
          confidence: number
          created_at?: string | null
          direction: string
          duration_minutes: number
          entry_price?: number | null
          exit_price?: number | null
          h1_bias?: string | null
          h4_bias?: string | null
          id?: string
          ob_timeframe?: string | null
          outcome?: string | null
          pattern_match_rate?: number | null
          score: number
          strength: string
          sweep_present?: boolean | null
          timestamp: number
        }
        Update: {
          adjusted_score?: number | null
          choch_present?: boolean | null
          confidence?: number
          created_at?: string | null
          direction?: string
          duration_minutes?: number
          entry_price?: number | null
          exit_price?: number | null
          h1_bias?: string | null
          h4_bias?: string | null
          id?: string
          ob_timeframe?: string | null
          outcome?: string | null
          pattern_match_rate?: number | null
          score?: number
          strength?: string
          sweep_present?: boolean | null
          timestamp?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
