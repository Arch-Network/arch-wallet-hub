# Security Hardening Backlog — derived from 2026-05 triage audit

Source: `/Users/brianhoffman/.cursor/plans/wallet_security_audit_triage_d1b286e9.plan.md` (130+ findings).

Status legend:
- **DONE** — addressed in the 2026-05 hardening sprint (commit history references each).
- **OPEN** — needs ticket/owner/ETA.
- **WONT_FIX** — accepted risk with rationale.

Each row is a candidate GitHub Issue body. Severity follows the original
triage (Critical / High / Medium / Low / Info).

---

## 0. Cross-cutting "fix this week" cluster

| ID | Sev | Title | Status |
|----|-----|-------|--------|
| X1 | Crit | SDK shared API key + caller-supplied externalUserId | DONE (laid groundwork; full per-user session token rollout still OPEN) |
| X2 | Crit | Background message handler has no `sender.id` check | DONE |
| X5 | High | Signing-request submit has no atomic claim → double-spend | DONE |
| X6 | High | Platform admin key compared with `!==` (timing oracle) | DONE |
| X7 | Crit | CDK `unsafeUnwrap()` leaks DB password to CloudFormation | DONE |
| X8 | Crit | Live indexer key committed in `apps/chrome-wallet/.env.local` | DONE (rotation procedure documented; operator must complete) |
| X9 | High | GH Actions pinned to mutable tags; CWS CLI unpinned | DONE |
| X10 | High | `/turnkey/indexeddb-keys` scope = parent org | DONE |

---

## 1. Chrome extension — `apps/chrome-wallet/`

### Critical

- **C1** Background `sender.id` not verified — DONE
- **C2** Auto-approve scaffold computed but un-enforced — DONE (computed-as-UI-hint only, never honored as directive)

### High

- **H1** Plaintext password in `chrome.storage.session` — DONE (handoff no longer carries password)
- **H2** Passkey `rpId` derived from dynamic `location.hostname` — DONE (pinned in `PASSKEY_RP_ID`)
- **H3** WebAuthn `userVerification` not `"required"` — DONE (registration + assertion both require UV)
- **H4** `GET_ACCOUNT` returns identity without connection check — DONE
- **H5** `host_permissions: ["<all_urls>"]` — OPEN: investigate scoped permissions / activeTab-only path
- **H6** `APPROVE_/REJECT_REQUEST` accept any sender — DONE

### Medium

- **M1** `genId()` low entropy — DONE (`crypto.randomUUID()`)
- **M2** `injected.js` web-accessible to `<all_urls>` — DONE (`use_dynamic_url: true`)
- **M3** Default `SitePermissions.readState: true` — OPEN: flip default to `false`; expose toggle in Settings
- **M4** Approve response broadcast to ALL tabs — DONE (per-tab delivery)
- **M5** PSBT with unknown fee approvable — OPEN: hard-block when `exactFee=false` and value > N sats
- **M6** PSBT no max-value sanity check — OPEN: introduce per-account "max spend without confirmation" guard
- **M7** Binary `SIGN_MESSAGE` approvable — OPEN: render 32-byte payloads as a "this looks like a transaction hash" warning, gate behind extra checkbox
- **M8** `innerHTML` in sidepanel error fallback — DONE (textContent / createElement)
- **M9** Clipboard no auto-clear — OPEN: clear after 30s for address/key copies
- **M10** Recovery email enumeration — OPEN: server already partially addressed via candidate masking; client should hide candidate count

### Low

- **L1** `log.debug/info` raw `extra` to console — OPEN: route through `sanitize()`
- **L2** No custom CSP in manifest — DONE
- **L3** Hardcoded Hub API keys in source — DONE (env-only)
- **L4** `MAX_SESSION_TTL_SECONDS = 4h` — DONE (reduced to 1h)
- **L5** Hardcoded third-party Vercel swap endpoint — OPEN: move to env, document trust assumption
- **L6** No TLS pinning — OPEN: evaluate cost/benefit (chrome MV3 doesn't expose easy hook)
- **L7** `window.bitcoin` shim `configurable: true` — OPEN: set to `false` to prevent late provider override

---

## 2. Backend API — `services/wallet-hub-api/`

### High

- **H1** Platform admin key `!==` — DONE (`timingSafeEqualStrings`)
- **H2** No row lock on signing-request status — DONE (atomic conditional `markSigningRequestSubmitted`)
- **H3** `/turnkey/indexeddb-keys` parent-org scope — DONE (sub-org scoping via stored row)
- **H4** Recovery `/init` returns unmasked `defaultAddress` — DONE
- **H5** No global rate-limit plugin — DONE (`@fastify/rate-limit`)

### Medium

- **M1** Platform routes only auth is static admin secret — DONE (also fails closed in prod)
- **M2** `PLATFORM_ADMIN_API_KEY` optional — DONE (required in prod via `getEnv`)
- **M3** No security headers (Helmet) — DONE
- **M4** No body-size limit — DONE (`bodyLimit: 256KiB`)
- **M5** CORS wildcard with credentials — DONE (`@fastify/cors`; refuses `*` in prod)
- **M6** Recovery `/verify` no row lock — OPEN: add `FOR UPDATE` around attempts increment
- **M7** Re-inject of raw `x-api-key` in sign-with-turnkey — OPEN: rotate to session token + sub-org-scoped sign call
- **M8** `computeCandidateToken` weak — OPEN: use HMAC with server secret instead of plain sha256 of public inputs
- **M9** Idempotency keys no TTL — OPEN: add scheduled GC job + per-row `expires_at`
- **M10** No `trustProxy` configured — DONE
- **M11** `/arch/accounts/airdrop` not env-gated — OPEN: feature-flag `ALLOW_FAUCET=false` by default; refuse in prod
- **M12** `getOrCreateUserByExternalId` runs in reads — OPEN: split to lookup-only paths
- **M13** Health endpoint leaks `NODE_ENV` — OPEN: trim health response

### Low

- **L1** App-key lookup writes `last_used_at` per request — OPEN: batch update via short-window cache
- **L2** Cosmetic dup of M8 — DONE (resolved with M8 plan)
- **L3** `signedTransaction` stored raw with no size bound — OPEN: enforce 256KiB at DB layer
- **L4** Error-level logging of full signature/pubkey/hash — OPEN: downgrade to debug + redact
- **L5** No expiry check on GET reconciliation — OPEN
- **L6** Swagger UI in prod without auth — OPEN: gate behind `ENABLE_DOCS` env flag (default off in prod)
- **L7** `btc/broadcast` no ownership check — OPEN: require session token + verify tx outputs belong to caller
- **L8** Idempotency keys global per `(appId, key, route)` — OPEN: scope to userId too

### Info

- No audit-log integrity (hash-chain) — OPEN
- No CI `npm audit` — DONE

---

## 3. SDK + UI — `packages/wallet-hub-sdk` / `packages/wallet-hub-ui`

### Critical

- **C1** Shared API key + caller-supplied `externalUserId` — partial DONE (SDK has `sessionToken` field + `signWithTurnkey` requires it); server-side per-user enforcement is **OPEN**.
- **C2** `signWithTurnkey` no user-presence proof — DONE on the client; server-side challenge **OPEN**.
- **C3** `baseUrl` unconstrained — DONE (`validateBaseUrl`)

### High

- **H1** `display` / `payloadToSign` untyped, no binding — partial DONE (`displayHash` on both create + get responses; `TransactionPreview` verifies). Server-side computation of canonical displayHash still **OPEN**.
- **H2** `usePortfolio` calls non-existent `getPortfolio` — DONE (method + type + hook)
- **H3** Full API error echoed — DONE (`summarizeErrorBody`)
- **H4** README pattern puts API key in browser — OPEN: rewrite README to recommend session-token model

### Medium

- **M1** Unguarded raw debug panel — OPEN
- **M2** Token strings rendered unvalidated — partial DONE (`truncate` everywhere in TransactionPreview); other components **OPEN**
- **M3** `readiness.reason` unsanitized — OPEN
- **M4** `fetchImpl` injection — OPEN: warn loudly if non-default fetchImpl in prod
- **M5** No HTTPS enforcement — DONE
- **M6** No fetch timeout — DONE (default 30s, configurable)
- **M7** `useWalletHubClient` requires `apiKey: string` — DONE (now optional)
- **M8** `arch.sign_message` raw JSON — OPEN: render as decoded BIP-322 metadata

### Low

- No `files` field in `wallet-hub-ui/package.json` — OPEN
- No LICENSE in SDK — OPEN
- `credentialBundle` zeroing guidance missing — OPEN
- `idempotencyKey` header format unchecked — OPEN
- `signingRequest.error` rendered raw — OPEN

---

## 4. Mobile wallet — out of scope

The in-tree mobile prototype (`apps/mobile-wallet/`) was removed in
2026-05; mobile wallet development now happens in a separate repository
owned by another team. Findings 4.C1–4.M7 below are retained only for
historical traceability; they no longer block this repo.

The deprecated mobile platform API key (`x7NaU5AHiZ...`) still must be
**revoked at the issuer** per the rotation checklist in `SECURITY.md`.

---

## 5. Infra / Deploy / CI

### Critical

- **C1** CDK `unsafeUnwrap()` on DB password — DONE (URL assembled in API at startup from secret-injected DB_USER/DB_PASSWORD)
- **C2** Live indexer key committed in `.env.local` — DONE (placeholders + SECURITY.md rotation checklist)
- **C3** `infra/cdk/cdk.context.json` tracked — DONE (gitignored in `e971017`; `git rm --cached` follow-up committed separately).

### High

- **H1** GitHub Actions pinned to tags — DONE
- **H2** `chrome-webstore-upload-cli` unpinned — DONE
- **H3** No HTTPS / no 80→443 redirect — DONE (gated on `certificateArn`)
- **H4** SSH + 3005 in public SG — DONE (no SSH; API service is private)
- **H5** `CORS_ALLOW_ORIGINS=*` default in CDK — DONE (refuses to deploy with `*`)

### Medium

- **M1** nginx no security headers — DONE
- **M2** `INTERNAL_API_KEY` plain env — DONE (Secrets Manager)
- **M3** RDS in public subnets — DONE (private with egress)
- **M4** RDS no deletion protection — DONE
- **M5** Containers run as root — DONE (`USER node` / `USER nginx`)
- **M6** apt-get without `--no-install-recommends` — N/A (Alpine images; documented to maintainers)
- **M7** Base images pinned to tag — OPEN: pin to digest in next CI run that records them
- **M8** `npm publish` no provenance, missing `id-token` — DONE

### Low / Info

- Workflows lack `permissions:` — DONE (all workflows have explicit per-job permissions)
- Healthchecks missing in Dockerfiles — DONE
- No multi-stage build for API — DONE (multi-stage with `npm prune --omit=dev`)

---

## 6. Dependencies

### High

- **H1** `@fastify/helmet`/`@fastify/rate-limit` missing — DONE
- **H2** Bespoke CORS plugin — DONE (`@fastify/cors`)
- **H3** `@turnkey/http` major-version split — DONE (aligned to v4 across all workspaces)
- **H4** `bitcoinjs-lib` v6 vs v7 split — DONE (aligned to v7)
- **H5** Vendored `arch-typescript-sdk/` outside npm audit — OPEN: convert to proper submodule or remove

### Medium

- **M1** `@noble/curves`/`hashes` not deduped — DONE (`overrides` in each workspace)
- **M2** `axios`/`undici`/`node-fetch` re-audit — OPEN: results captured by `security-checks.yml`
- **M3** `@turnkey/wallet-stamper` brings `viem` + `ox` — OPEN: remove if unused
- **M4** Expo / Metro audit — OPEN: results captured by `security-checks.yml`
- **M5** Lockfiles not verified for off-registry sources — DONE (`lockfile-lint` job)
- **M6** No `engines` block — OPEN: add per package
- **M7** Two parallel Arch SDKs — OPEN: pick one

### Low

- `@fastify/swagger-ui` always-on — OPEN (cross-ref API L6)
- `uuid` package unused — OPEN: prune

---

## Triage process for new findings

1. Add a row to the relevant section above with severity + 1-line title.
2. Open a GitHub Issue using the corresponding row as the body.
3. Link the Issue back to this file in the row's "Status" cell.
4. When resolved, mark **DONE** and reference the merging PR.
