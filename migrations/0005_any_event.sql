-- 0005_any_event: phase 4 (docs/BUILD_SPEC.md §9): Eventbrite, pasted links,
-- described events and category browse.
--
-- APPEND-ONLY: never edit this file once merged; add 0006_*.sql instead.
--
-- trip_requests.event_pinned_provider - who event_pinned_id belongs to:
--   'ticketmaster' or 'eventbrite'. NULL on rows from before this migration,
--   which were all Ticketmaster pins (or no pin).
-- trip_requests.event_url - a pasted event page ('url' pins) that every run,
--   re-check and scheduled check reads again.
-- trip_requests.event_manual - 1 when the user described the event (name,
--   city, one date) because no provider or page had it.
--
-- events.provider gains 'eventbrite', 'url' and 'manual' values; it has no
-- CHECK constraint, so nothing changes there.

ALTER TABLE trip_requests ADD COLUMN event_pinned_provider TEXT
	CHECK (event_pinned_provider IS NULL OR event_pinned_provider IN ('ticketmaster', 'eventbrite', 'url'));
ALTER TABLE trip_requests ADD COLUMN event_url TEXT;
ALTER TABLE trip_requests ADD COLUMN event_manual INTEGER NOT NULL DEFAULT 0
	CHECK (event_manual IN (0, 1));
