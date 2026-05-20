# Arch Prime Mobile — Extension State Questionnaire

**Respondent:** Brian
**Date:** 2026-04-20
**Ground truth source:** `arch-wallet-hub` monorepo @ `07a2b55` (`apps/chrome-wallet`, `services/wallet-hub-api`, `packages/wallet-hub-sdk`).

Heads-up before you read: a couple of the v1 plan's assumptions don't match reality. I'm going to correct those inline rather than play along — better you find out now than after v2 locks.

---

## BRIAN-01 — Turnkey policy engine configuration

**Nothing is deployed. There is no policy engine config today.**

Concretely:

- **Non-custodial wallets:** we call `createSubOrganization` with `rootQuorumThreshold: 1` and a single passkey authenticator. No `policies: []`, no spending limits, no destination allowlists, no step-up gating, no co-signers, no time-locks. See `services/wallet-hub-api/src/turnkey/client.ts` → `createSubOrganizationWithWallet`, and the route handler at `services/wallet-hub-api/src/routes/turnkey.ts:218` where `policyId: null` is hardcoded on insert.
- **Custodial wallets:** the wallet keys live in the parent org and are signed by the server using `ApiKeyStamper`. No per-user policy; the only gate is server-side auth (`x-api-key` / request audit).

Safety posture today is effectively:

- **Non-custodial:** "passkey presence required for every signature" (enforced by Turnkey because the sub-org's only authenticator is the user's passkey).
- **Custodial:** "our server signs whatever our API route accepts." No on-key policy.

**Mobile implication:** there's nothing for mobile to match, because nothing is set. If we want real safety (spending caps, destination allowlists, step-up), it's a **shared extension + API deliverable** — design the policy set once, deploy against the root org, and let both clients inherit. Don't let the mobile plan assume these exist.

---

## BRIAN-02 — Recovery flow state

### (a) Email-credential recovery

**Not implemented. Not even stubbed.**

- The `Unlock` page (`apps/chrome-wallet/src/pages/Unlock/Unlock.tsx`) has one button: "Unlock with Passkey". No "I lost my passkey" affordance.
- The `Settings → Reset Wallet` dialog explicitly tells users: *"This will erase all wallet data from this extension. You can re-import using your passkey."* — that's not recovery, that's re-auth against the existing passkey on the existing device.
- We do not call Turnkey's `EMAIL_AUTH` / `initUserEmailRecovery` / `recoverUser` activities anywhere in the codebase. No email recovery credential is ever minted or stored.

If a user loses their passkey today, their sub-org is unrecoverable from our client. The mitigation is that the Hub keeps a mapping `externalUserId → subOrganizationId`, so in theory we could admin-reset a user via the Turnkey console, but there is no product surface for it.

### (b) Seed-export UX

**Not implemented.** No export, no backup reveal, no recovery material visible anywhere in the extension.

- Turnkey holds the 12-word mnemonic inside the sub-organization wallet (we pass `mnemonicLength: 12` in `createWallet`). The user never sees it.
- Settings only exposes BTC address + public key + truncated wallet label. No "Show Recovery Phrase" / "Export" button.
- We do not call `exportWallet` / `exportPrivateKey` / `initUserExport` against Turnkey anywhere. `@turnkey/iframe-stamper` (what you'd use for the encrypted export iframe on web) isn't even a dependency.

**Matt's backup requirement is therefore a from-scratch deliverable**, and I'd build it once for both clients:

- **Extension:** Turnkey's iframe export flow (`@turnkey/iframe-stamper` + their export iframe URL).
- **iOS:** Turnkey's secure export via Swift SDK (the equivalent uses a secure-enclave-bound ephemeral key instead of an iframe).

Plan accordingly. Don't assume mobile "inherits" this — there is nothing to inherit.

---

## BRIAN-03 — Social recovery vs social sign-on — disambiguation

**Neither is live. The extension is passkey-only.**

- Onboarding (`Onboarding.tsx`) has three paths: Create Passkey Wallet, Create Custodial Wallet, Import Existing. All three use `externalUserId = crypto.randomUUID()` (persisted locally) as identity. There is no OAuth step at any point.
- No Google / Apple / X sign-in code. `@turnkey/sdk-browser`'s OAuth clients are not imported. `apps/chrome-wallet` has zero references to `oauth`, `googleClient`, `appleClient`, `signInWith*`, etc.
- No N-of-M approver / social recovery quorum. `rootQuorumThreshold` is always `1`.

**The v1 plan mis-states this.** Please strike the "social sign-on is already wired" assumption. If we want either:

- Social **sign-on** is ~hours-to-days of Turnkey OAuth wiring on each client + a tiny backend endpoint to exchange the OIDC token for a sub-org bootstrap.
- Social **recovery** is weeks (policy-engine config + approver UX + invite flow + admin tooling).

For v1 I'd recommend scoping in social sign-on (Google + Apple, both clients) and deferring social recovery past v1.

---

## BRIAN-04 — Shared TypeScript package inventory

There are two internal packages. Only one is load-bearing.

| Package | Path | What's in it | Who uses it |
|---|---|---|---|
| `@arch-network/wallet-hub-sdk` | `packages/wallet-hub-sdk/` | Thin `WalletHubClient` (fetch wrapper) + TS types for every API request/response | chrome-wallet, mobile-wallet, demo-dapp, wallet-hub-api |
| `@arch/wallet-hub-ui` | `packages/wallet-hub-ui/` | Small React hooks/components kit. Pre-redesign scaffolding. | Not consumed by the extension today (extension has its own CSS + React components). Effectively vestigial. |

Both are linked via `file:../../packages/...` (npm workspaces, no publish).

**What's inlined, not shared:**

- Terminology (e.g. `ASSET_META` in `apps/chrome-wallet/src/pages/Send/Send.tsx`, network label strings, "Passkey" / "Custodial" badges).
- Formatting (`apps/chrome-wallet/src/utils/format.ts`) — BTC/ARCH/APL unit formatting, address truncation, timestamp helpers.
- BTC network re-encoding (`apps/chrome-wallet/src/utils/addressNetwork.ts`).
- Arch RPC metadata enrichment (`apps/chrome-wallet/src/utils/arch-rpc.ts`) — SPL/APL mint + Borsh metadata PDA parsing. **This one hurts to duplicate on Swift.**
- Turnkey glue (`new Turnkey({ apiBaseUrl, defaultOrganizationId, rpId })` + passkey sign flows). Extension's version is React/web; mobile has its own `src/services/turnkey.ts`. No shared wrapper.

**What's definitely not in any shared package:** risk / LTV / health-factor logic. Because it doesn't exist anywhere — see BRIAN-05. The v1 plan's §10 E-series items assuming a risk module are based on a surface that isn't built.

**Mobile codegen strategy recommendation:**

1. Generate Swift models from `openapi.yaml` (at repo root) for wire types. That covers ~95% of what the client needs.
2. Re-derive BTC/ARCH unit formatting in Swift (trivial, ~1 file).
3. Port `arch-rpc.ts` PDA derivation + Borsh mint/metadata parsers to Swift. This is the one non-obvious port (~1–2 days). **Alternative:** add a `/v1/wallet/tokens/:mint/enriched` endpoint on the Hub so both clients stop deriving PDAs themselves — I'd actually prefer this path; it moves the on-chain read off both clients and behind one cache.

---

## BRIAN-05 — Yield product API + implementation state

**Does not exist.** Not live, not staged, not designed. This is the bigger correction to the v1 plan.

Search confirms:

- `openapi.yaml` contains zero `swap`, `borrow`, `yield`, `lend`, or `LTV` routes.
- `services/wallet-hub-api/src/routes/` has: `archAccounts`, `archTransactions`, `btc`, `btcTransactions`, `health`, `platform`, `portfolio`, `signingRequests`, `turnkey`, `turnkeySessions`, `walletLinking`, `walletProxy`. No yield / swap / borrow route.
- chrome-wallet UI has no Swap / Borrow / Yield pages. The surfaces are Dashboard / Tokens / Send / Receive / History / Settings / Approve / Unlock / Onboarding.
- HoneyB is not integrated. No dependency, no reference.

So: "Send/Receive/Swap/Borrow APIs" as the v1 plan describes them is a **plan artifact, not a product**. Only Send (`POST /v1/btc/send`, `POST /v1/signing-requests` + `.../submit` | `.../sign-with-turnkey`) and Receive (address display + `GET /v1/portfolio/...`) ship today.

**Recommendation:** strip Phase 4c (Yield) and any Swap/Borrow phases from v1 of the mobile plan. Either:

- **(a)** Mobile v1 scope = parity with what the extension actually does = Send + Receive + Sign (BTC + ARCH + APL transfers), or
- **(b)** Mobile v1 waits on a backend push that builds Swap/Borrow/Yield **as shared APIs**, and both clients light them up together in a v2.

I'd pick (a). We'll ship faster and not couple mobile's timeline to product decisions that haven't been made.

---

## BRIAN-06 — iOS / mobile engineering team state

**iOS team state:** No one assigned. No contractor in talks that I know of.

The `apps/mobile-wallet` directory exists as an Expo SDK 55 / React Native 0.83 scaffold (tabs for Send / Receive / History / Settings / Browser; one `src/services/turnkey.ts`; uses `@arch-network/wallet-hub-sdk` for API calls and `@turnkey/react-native-passkey-stamper` + `@turnkey/http` for signing). It's a scaffold — not an app. I wrote the scaffold to de-risk the React Native + Turnkey passkey-stamper wiring; it is not feature-complete.

If the plan calls for native Swift, that's a separate effort; the scaffold would be thrown away. If the plan accepts React Native (Expo) iOS, we have a ~10% head start.

**My capacity for a 2-week parallel code-level intake sprint (BRIAN-01..04 as deliverables):** honestly, **partial — ~50% for 2 weeks, not 100%.** Extension still has open product work (BTC send UX polish, network health banner follow-ups, preparing for Chrome Web Store review) that I can't fully stall. What I can commit to in a parallel 2-week slot:

1. Extract formatting + asset metadata + terminology into `@arch/wallet-hub-shared` (new package). High-leverage, ~2 days.
2. Port `utils/arch-rpc.ts` (PDA/Borsh) to a backend endpoint `/v1/tokens/:mint/enrich`, delete the client-side version, consume from both clients. ~2–3 days.
3. Draft a Turnkey policy spec (spending caps + destination allowlist thresholds) and deploy against the root org — then both clients inherit it. ~2 days plus review.
4. Build Turnkey email recovery + seed-export UX in the extension as the reference implementation mobile will mirror. ~4–5 days.

Items 3 and 4 are the real unblockers. 1 and 2 are nice-to-haves.

What I **cannot** commit to in that window is writing Swift / becoming the iOS engineer. You need a dedicated iOS hire (or an Expo/RN-fluent contractor if you're OK with RN). Start sourcing today regardless of plan version.

---

## BRIAN-07 — Turnkey SDK specifics

### Versions

**Extension** (`apps/chrome-wallet/package.json`):

```json
"@turnkey/sdk-browser": "^5.2.1"
```

That's the only Turnkey package in the extension. No `iframe-stamper` (we don't export), no separate passkey package (it's bundled).

**Backend** (`services/wallet-hub-api/package.json`):

```json
"@turnkey/api-key-stamper": "^0.5.0",
"@turnkey/http": "^3.16.0",
"@turnkey/sdk-types": "^0.11.0"
```

**Mobile scaffold** (`apps/mobile-wallet/package.json`):

```json
"@turnkey/http": "^3.17.1",
"@turnkey/react-native-passkey-stamper": "^1.2.11"
```

### Forks / customizations

**None.** No `patch-package`, no forks, no monkeypatches. All off-the-shelf.

### Split: `@turnkey/sdk-server` vs direct Turnkey API

We do not use `@turnkey/sdk-server`. On the backend we talk to `@turnkey/http` directly with an `ApiKeyStamper`. That's a deliberate choice — `sdk-server` adds abstractions we didn't need and a version surface we didn't want. If you go Swift on iOS, the equivalent question doesn't apply; if you go RN, consider staying on `@turnkey/http` + platform-specific stampers, same as us.

Which ops go through the backend vs client:

- **Custodial signing** → backend → `TurnkeyService.signRawPayload` / `signBitcoinTransaction`. Server holds the API key.
- **Sub-org creation** → backend → `createSubOrganization` (because passkey attestation goes through the backend audit/DB layer first). Client sends attestation to backend, backend calls Turnkey.
- **Passkey signing (non-custodial)** → **client-side direct to Turnkey**. `new Turnkey({ apiBaseUrl: "https://api.turnkey.com", defaultOrganizationId: subOrgId, rpId }).passkeyClient().signRawPayload(...)` / `.signTransaction(...)`. Backend never sees the signature until the client submits it back via `/signing-requests/:id/submit`.

### Known quirks / workarounds

1. **PSBT hex/base64 normalization.** Turnkey's `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` for `TRANSACTION_TYPE_BITCOIN` wants hex in `unsignedTransaction`, but our BTC flow produces base64 PSBTs. We normalize both directions in `TurnkeyService.signBitcoinTransaction` (`services/wallet-hub-api/src/turnkey/client.ts:342–378`). Mobile must replicate — use hex on the wire to Turnkey, base64 for internal PSBT handling.
2. **`createSubOrganizationResult` version drift.** Turnkey has rolled V4/V5/V6/V7 of that result shape. We check all of them defensively (`turnkey/client.ts:254–260`). If you pin a newer Turnkey SDK on iOS, verify the result field name — it will bite you.
3. **`defaultOrganizationId` gotcha.** For passkey (non-custodial) signing, the client-side `new Turnkey({ defaultOrganizationId })` must be the **sub-organization ID**, not the parent org. Using the parent org in a passkey context returns an auth error that doesn't obviously say "wrong org". Bake this into your Swift/RN wrapper so no feature dev has to remember it.
4. **`PAYLOAD_ENCODING_HEXADECIMAL` + `HASH_FUNCTION_NO_OP`** is what we use for Arch (ed25519 / SHA-256-already-applied payload). Don't let Turnkey hash it again. Extension uses this combination in `Send.tsx:146–152`.
5. **Taproot address format + derivation path are network-specific.** Testnet → `ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR` + `m/86'/1'/0'/0/0`. Mainnet → `ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR` + `m/86'/0'/0'/0/0`. We pick based on the `x-network` request header. Mobile must send the same header or it'll create mismatched addresses. Also: the **key is network-agnostic**; we re-encode the address string for display per network (`utils/addressNetwork.ts`). Mirror this, don't re-derive a new key for mainnet.

---

## BRIAN-08 — Arch RPC surface for tx broadcast

**Server-side broadcast. Client is a pure API consumer for writes.**

Full picture:

| Flow | Signing | Broadcast |
|---|---|---|
| BTC send, custodial | Server (ApiKeyStamper → Turnkey `signTransaction`) | `POST /v1/btc/send` — server broadcasts |
| BTC send, passkey | Client (`tk.passkeyClient().signTransaction`) → returns signed PSBT hex | `POST /v1/btc/finalize-and-broadcast` with signed PSBT base64 — server broadcasts via bitcoind |
| ARCH / APL transfer, custodial | Server (`/v1/signing-requests/:id/sign-with-turnkey`) | Same route — server builds, signs, submits to Arch RPC |
| ARCH / APL transfer, passkey | Client (`tk.passkeyClient().signRawPayload` over `payloadHex`) | `POST /v1/signing-requests/:id/submit` with `{ signature64Hex }` — server assembles runtime tx and submits to Arch RPC (`submitArchTransaction` in `src/arch/arch.ts`) |

**Auth model:** all of the above are `x-api-key` + `x-network` + `idempotency-key` against the Hub API. There is no direct client → Arch RPC write surface.

The one place the client **does** talk to Arch RPC directly is **read-only**: `apps/chrome-wallet/src/utils/arch-rpc.ts` calls the public `rpc.testnet.arch.network` / `rpc.mainnet.arch.network` JSON-RPC endpoints for `read_account_info` to enrich token mint + metadata PDAs when the indexer lacks decimals/metadata. No auth on those reads.

**Mobile implication:** you get the simpler security model. Single network dependency (the Hub) for every write. The Arch RPC read path is optional — I'd push it off the client entirely (see BRIAN-04 recommendation to add `/v1/tokens/:mint/enriched` server-side). That gets mobile to "talks to exactly one backend" which is what you want for iOS review + mTLS + key pinning posture.

---

## Optional — anything else

Things the mobile plan should not get wrong:

1. **`externalUserId` is the identity anchor.** It's a client-generated UUID stored locally (`getExternalUserId()` in `apps/chrome-wallet/src/utils/sdk.ts`). The backend keys every Turnkey resource off it via `getOrCreateUserByExternalId`. If mobile generates a *new* UUID on fresh install, **it is a new user to the Hub**, and it will not see the extension's wallets. Two options: (a) require users to "import existing" via passkey discovery + `listTurnkeyWallets`, or (b) build a real login (OIDC-backed `externalUserId`) and retire the UUID pattern. Option (b) is the right long-term move and is the same work as BRIAN-03 social sign-on. Bundle them.

2. **Idempotency keys are mandatory on `POST /turnkey/wallets` and `/turnkey/passkey-wallets`.** Server rejects without one. Use `crypto.randomUUID()` on each call site. It's in the API contract; mobile's SDK consumer must respect it.

3. **Network switch is a header, not a base URL.** `x-network: testnet` or `x-network: mainnet`. Mobile should never hardcode testnet URLs; just flip the header. The backend handles the rest (address format, BTC node, Arch RPC node).

4. **`isCustodial` is a runtime shape, not a user setting.** It's derived server-side from `subOrganizationId == null`. Mobile's wallet model must carry this flag and branch signing logic on it exactly like the extension does (see `Send.tsx` for the canonical pattern). Don't fork the branching into individual screens — put it behind a `signForAccount(account, payload)` in a Turnkey service wrapper.

5. **Things I'd redo today, given the chance:**
   - Put the on-chain Arch RPC reads behind a Hub endpoint from day one. Having two clients each parse Borsh is avoidable pain.
   - Ship with a minimal policy (destination allowlist per user, spending cap, step-up over threshold) from the start. Retrofitting later is awkward because existing sub-orgs each need an activity to add the policy.
   - Stabilize the `externalUserId` identity model before shipping a second client. We're about to learn this the hard way on mobile if we don't fix it first.

6. **Anti-pattern I want to avoid on mobile:** don't replicate the extension's "Turnkey SDK instantiated inside a React component" pattern in Send / Approve. It's fine for a browser extension; on iOS it'll make biometric prompts, secure-enclave key lifecycle, and backgrounding/foregrounding races much harder to reason about. Put all Turnkey calls behind a single service class (`TurnkeySigner`) with explicit `prepareSignature(payload) -> signed` semantics. The mobile scaffold's `src/services/turnkey.ts` is the start of that — build on it.
