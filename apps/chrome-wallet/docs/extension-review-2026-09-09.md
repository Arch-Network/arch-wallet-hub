# Chrome wallet review — September 9, 2026

Scope: source review of onboarding, unlock, history, collectibles, send, swap,
approval presentation, manifest, imagery, and test tooling. This is a focused
implementation and UX review, not a comprehensive security audit. Findings below
are source-derived unless explicitly described as tested. Functional changes are
recommendations; this change implements the imagery replacement only.

## Prioritized fixes

1. **P1 — Ignore obsolete history responses.** `src/pages/History/History.tsx:108`
   starts asynchronous loading without a request generation or cancellation guard;
   line 480 commits the result unconditionally. Switching account/network while a
   previous fetch is pending can show the previous account's transactions under
   the new selection. Guard every state update (including errors and loading) with
   the active request ID, and clear results on identity changes. Test two delayed
   responses resolving in reverse order. Also guard the outer error path against
   retaining history from the previously selected account.

2. **P2 — Let token artwork recover when its URL changes.**
   `src/components/TokenIcon.tsx:56` stores a permanent boolean error for the mounted
   component. After one failed image, a newly resolved or different token image
   cannot appear. Track the failed URL rather than a global boolean, or reset
   failure state when `image` changes. Verify failed URL A followed by valid URL B.

3. **P2 — Associate form labels with inputs.** Password labels in
   `src/pages/Onboarding/Onboarding.tsx:120` and
   `src/pages/Unlock/Unlock.tsx:70` lack `htmlFor`/matching input IDs. Add stable IDs,
   associate error/help text with `aria-describedby`, and announce errors. Check
   keyboard use and accessible names across the entire onboarding wizard.

4. **P2 — Use token metadata for swap precision.**
   `src/utils/format.ts:44` selects two decimals for USDC and eight for everything
   else. A small positive USDC quote can display as `0.00`, while other tokens can
   show digits beyond their actual precision. Thread token decimals into the cards,
   use an explicit less-than display for tiny positive values, and retain full
   meaningful precision in the review details. Test tiny amounts and six-/nine-
   decimal tokens.

5. **P2 — Restore the documented E2E command.** `e2e/README.md` instructs running
   `npm run test:e2e`, but `package.json` has no such script. Add a script that builds
   and runs `playwright test --config e2e/playwright.config.ts`, then wire it into CI.
   Existing unit tests do not replace browser-level approval and onboarding checks.

6. **P3 — Distinguish an empty filter from an empty wallet.**
   `src/pages/History/History.tsx:562` says “No transactions yet” when the selected
   chain has no matches even if another chain has transactions. Use “No Bitcoin
   transactions” / “No Arch transactions” and offer “Show all activity.”

## Upgrades and features worth scheduling

- **Transaction lifecycle:** pending → confirmed / failed status, last checked time,
  and a refresh action. Evaluate a guided BTC fee-bump flow for eligible transactions
  with explicit replacement-fee review.
- **Activity tools:** search by recipient/transaction ID, date filters, and CSV export.
  These complement the existing chain filters and saved contacts.
- **Recovery readiness:** a concise settings summary of the account's recovery method,
  verification state, and next action, tailored to linked versus Hub accounts.
- **Approval clarity:** build on the existing origin badges and risk summaries with
  decoded balance changes where supported; identify unavailable simulation clearly.
- **Build maintenance:** investigate the observed `vm-browserify` eval warning and
  remove unused Node polyfills from browser bundles where possible. The warning is
  not evidence of an exploitable vulnerability. The build also flags WXT's deprecated
  `runner` configuration; migrate it in a focused maintenance change.

## Imagery implemented

The generic mailbox and picture-frame emoji in Activity and Collectibles are now
bespoke generated ceramic illustrations in terracotta, ivory, and charcoal. A shared
`EmptyStateArt` component reserves a 128 × 128 footprint and treats the artwork as
decorative. Local 384 × 384 WebP assets total approximately 14 KB. They require no
external image requests. Existing Arch marks, asset logos, and actual collectible
content remain appropriate identity artwork.

See `generated-imagery.md` for exact prompts and generation provenance.

## Validation

- TypeScript check passed after integration.
- Existing unit suite: 49 files / 466 tests passed.
- Production build and no-inline-script postbuild check passed.
- Live passkey, email recovery, signing, and broadcast were not exercised.
