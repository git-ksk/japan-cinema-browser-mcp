## Summary

<!-- What changed, and why? -->

## Safety / provider impact

<!-- Which browser, provider, capability, or security boundary is affected? Use "none" when not applicable. -->

- [ ] No private/internal API, hidden endpoint, network interception, or route/query guessing was introduced.
- [ ] Disabled seat/checkout/purchase capabilities are not bypassed through generic automation.
- [ ] Sensitive data handling and challenge/CAPTCHA human-handoff behavior are unchanged or explicitly reviewed.
- [ ] Provider-specific DOM knowledge remains scoped to the relevant adapter.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] Relevant documentation updated, or no documentation change is needed.

### Live smoke

<!-- Optional and provider-specific. Do not run purchasing, seat-hold, login, or high-frequency automation. -->

- Provider(s):
- Result / not run reason:

## Remaining risk / uncertainty

<!-- Include UI drift, provider-policy, compatibility, or rollout uncertainty. Do not claim legal approval. -->
