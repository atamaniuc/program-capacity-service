-- The schema backs the states (architect review of T11-T13, m5): a request that is paying out or
-- paid has a reservation, a completed one has a payment. A driver bug cannot write otherwise.

ALTER TABLE funding_request
  ADD CONSTRAINT funding_request_disbursing_has_reservation
    CHECK (state NOT IN ('DISBURSING', 'COMPLETED') OR reservation_id IS NOT NULL),
  ADD CONSTRAINT funding_request_completed_has_payment
    CHECK (state <> 'COMPLETED' OR payment_id IS NOT NULL);
