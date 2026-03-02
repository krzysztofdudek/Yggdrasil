# Subscription Upgrade Flow

## Business context

Free user upgrades to Pro to remove limits (unlimited expenses, unlimited custom categories). On start: mock upgrade without real payment.

## Trigger

User on Settings or Subscription page clicks "Upgrade to Pro".

## Goal

Plan changed to Pro. Limits removed. UI shows "You have Pro".

## Participants

- `api/subscriptions` — updates plan to pro
- `web/settings` — upgrade button, subscription card, plan display

## Paths

### Happy path (mock)

Update Subscription plan → pro → 200. Frontend refreshes, shows "You have Pro".

### Already Pro

User already on Pro. API returns 200 idempotently or 400. UI shows current plan.

### Future: real billing

Stripe checkout → webhook → update. Not implemented on start.

## Invariants across all paths

- Downgrade Pro→Free optional on start. Can be omitted.
