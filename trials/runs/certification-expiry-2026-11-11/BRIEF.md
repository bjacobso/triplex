# Technician certification and derived renewal work

A facilities team assigns technicians to sites. Each site requires named certifications; a
technician may work there only while every required certification is current. Certificates have
an effective date and an exclusive expiry instant. A renewal may be future-effective, overlap an
older certificate, or arrive late as a correction. Use UTC instants and synthetic data only;
this is an illustrative back-office workflow, not safety advice.

Derive one renewal work item per technician and certification when coverage expires within 30 days
and no renewal provides uninterrupted coverage. Repeated evaluation must not create duplicate
open work. Completing a renewal should resolve obsolete work while preserving its audit history.
An assignment becoming ineligible merely because time passes must be detected without requiring
an unrelated write. Separate derived candidates from application-owned work lifecycle and delivery.

Include two sites with different requirements, a technician missing one certificate, a certificate
expiring exactly at the evaluation instant, a seamless renewal, a renewal with a gap and a late
correction. Choose fixed dates and state interval assumptions explicitly.

Tests must answer:

1. Which assigned technicians are eligible at a chosen instant, and why are the others ineligible?
   Does coverage change correctly immediately before, at and after expiry and renewal boundaries?
2. Which renewals are due within 30 days? Do overlapping evidence and repeated derivation runs
   avoid duplicate candidates and duplicate open work items?
3. When time advances without writes, how is expired coverage detected and derived work refreshed?
   Can a future-effective renewal avoid a false gap while a late renewal still exposes a real gap?
4. After a correction, which materialized results are stale? Can the result be refreshed and its
   source facts, source position and temporal basis explained?
5. What did the team believe about eligibility before the correction, and what does it now believe
   about that same valid instant? Who asserted or corrected the evidence?
6. Does renewal resolve obsolete work without erasing previous decisions? Which parts are enforced
   by Triplex and which require host guards, scheduling or reconciliation?

Exercise the same portable questions on KV and SQLite, recording any unsupported behavior or
backend coverage limits honestly. Do not implement a scheduler inside Triplex to satisfy the brief.
