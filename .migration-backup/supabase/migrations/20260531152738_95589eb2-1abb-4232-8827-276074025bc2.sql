-- Lock down V75 tables: public reads OK (read-only dashboards), writes server-only via service_role.
DROP POLICY IF EXISTS v75_seg_all ON public.v75_segment_records;
DROP POLICY IF EXISTS v75_cond_all ON public.v75_condition_stats;
DROP POLICY IF EXISTS v75_hist_all ON public.v75_signal_history;

-- v75_segment_records
CREATE POLICY "v75_seg_public_read" ON public.v75_segment_records FOR SELECT TO anon, authenticated USING (true);

-- v75_condition_stats
CREATE POLICY "v75_cond_public_read" ON public.v75_condition_stats FOR SELECT TO anon, authenticated USING (true);

-- v75_signal_history
CREATE POLICY "v75_hist_public_read" ON public.v75_signal_history FOR SELECT TO anon, authenticated USING (true);

-- Revoke client write access; service_role still has ALL (bypasses RLS anyway and retains grants).
REVOKE INSERT, UPDATE, DELETE ON public.v75_segment_records FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v75_condition_stats FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v75_signal_history FROM anon, authenticated;

GRANT SELECT ON public.v75_segment_records TO anon, authenticated;
GRANT SELECT ON public.v75_condition_stats TO anon, authenticated;
GRANT SELECT ON public.v75_signal_history TO anon, authenticated;

GRANT ALL ON public.v75_segment_records TO service_role;
GRANT ALL ON public.v75_condition_stats TO service_role;
GRANT ALL ON public.v75_signal_history TO service_role;