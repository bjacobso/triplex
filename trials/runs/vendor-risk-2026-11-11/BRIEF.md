# Vendor risk review

vendor risk review for a 200-person SaaS company. Vendors
touching customer data need a security review before contract signature (completed questionnaire +
current SOC 2 Type II or approved exception); reviews expire after 12 months; high-risk vendors
(processing customer personal data) also need a DPA; exceptions are CISO-only, need a reason, and
expire after 6 months; procurement must not mark a vendor active while its review is incomplete or
expired. Synthetic data only; illustrative, not compliance advice.

Tests must answer:

1. Which vendors need a review now?
2. Which active vendors have an incomplete or expired review as of a chosen date?
3. Which exceptions expire within 30 days?
4. What was a vendor’s review state on a past date, and who asserted it? How does a later
   recorded correction change what was believed about that date?
5. Which requirements are enforced, which need a host guard, and which can only be detected?
   Include unauthorized exceptions, missing reasons, direct activation and expiry without writes.
6. Do the portable questions give identical answers on KV and SQLite?
