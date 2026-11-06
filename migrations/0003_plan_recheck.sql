-- 0003_plan_recheck: "re-check price" (docs/BUILD_SPEC.md §9, phase 2).
--
-- APPEND-ONLY: never edit this file once merged; add 0004_*.sql instead.
--
-- A re-check is a new plan for the same trip request, run with fresh provider
-- calls. rechecked_from points at the plan it re-checks, so the app can show
-- what changed and phase 3 price-drop alerts can compare runs.

ALTER TABLE plans ADD COLUMN rechecked_from TEXT REFERENCES plans(id);
CREATE INDEX IF NOT EXISTS plans_trip_request ON plans (trip_request_id, created_at);
