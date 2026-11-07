# Ridgeline Quote Approval Policy (current)

Assume the current time is **Monday, October 12, 2026, 09:30 Central** when you process the sample drafts.

## Always
1. **A person signs off on every quote before it is sent.** A quote specialist gives final approval on every quote, even when no manager approval is needed.
2. Prices come from the reporting database. Never change a price without a person approving it.

## Pricing
3. Use the customer's **contract price** when one exists and is valid today (`valid_from` <= today <= `valid_to`). Otherwise use the **list price**.
4. If a contract price exists but has expired, use the list price and flag the line for the specialist.
5. The draft's `proposed_discount_pct` is applied on top of the line price (contract or list).
6. **Effective discount** for approval purposes = 1 - (quote net total / quote total at list price).

## Who must approve (after specialist review)
| Condition | Approver |
|---|---|
| Effective discount 15% or less **and** net total under $25,000 | Quote specialist only |
| Effective discount over 15% up to 25%, **or** net total $25,000 or more | Regional manager for the customer's region |
| Effective discount over 25% | VP of Sales |

7. If the required approver is out of office today, route to their `backup_approver_id` (see `reporting_db/approvers.csv`).

## Lines that need a specialist before routing
8. Any line with `extraction_confidence` below 0.85.
9. Any part that is out of stock in all warehouses, or not found in the stock API (the specialist decides: backorder, substitute or remove).
10. Any stock reading older than 24 hours, or a reporting database export older than 36 hours (data must be confirmed).

## Duplicates
11. A draft with the same `rfq_id` and the same lines as a draft received in the last 24 hours is a duplicate. Do not create a second approval request.

## Audit
12. Record every action: who, what, when, and before/after values for any edited field.
