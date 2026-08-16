# ATS Challenge P0 Regression Evidence

Date: 2026-08-15

## Safety Boundary

- Formal detection rules remain limited to Moka/Mokahr main-document flows and DJI paths.
- Every Challenge scenario paused browser automation before any form execution.
- Every synthetic task reported `submissionCount: 0`.
- Evidence is limited to commands, aggregate pass counts, finite Challenge kinds, call ordering, and submission counters.
- No DOM dumps, selectors, original Challenge text, URL query strings, candidate data, credentials, tokens, or browser-profile paths are retained here.

## Verification Results

| Command | Result |
| --- | --- |
| `rtk pnpm --filter @resume/synthetic-ats test -- server.test.ts` | 4 tests passed |
| `rtk pnpm --filter @resume/contracts test` | 65 tests passed |
| `rtk pnpm --filter @resume/browser-worker test` | 111 tests passed |
| `rtk pnpm --filter @resume/api test` | 458 tests passed |
| `rtk pnpm --filter @resume/web test` | 173 tests passed |
| `rtk pnpm test:e2e -- ats-challenge-p0.spec.ts ats-runtime-p0.spec.ts submit-safety.spec.ts` | 18 tests passed |
| `rtk pnpm typecheck` | 0 errors |

## Finite Challenge Outcomes

The eight deterministic scenarios map to seven finite Challenge kinds:

| Scenario class | Challenge kind |
| --- | --- |
| CAPTCHA | `captcha` |
| Main-document HTTP 403 | `access_denied` |
| Main-document HTTP 429 | `rate_limited` |
| Device verification | `device_verification` |
| Risk control | `risk_control` |
| Visible iframe boundary | `unsupported_iframe` |
| Interactive open or closed Shadow boundary | `unsupported_shadow_dom` |

- Detection persisted `awaiting_challenge` and produced no browser execute call.
- Removing a CAPTCHA signal and waiting one second did not resume automation.
- Explicit resume invalidated the old execution state before starting a fresh observation (`invalidate -> observe`).
- The resumed clean scenario reached `review_locked`; stale execution epochs, node references, and approvals remained invalid.
- The combined Challenge, Runtime, and submit-safety matrix completed with `submissionCount: 0` in every scenario.
