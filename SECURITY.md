# Security policy

## Reporting a vulnerability

Email security@arch.network. Do **not** open a public GitHub issue for
suspected vulnerabilities. We aim to acknowledge within 2 business days
and ship a fix or mitigation within 14 days for High/Critical issues.

## Active rotation checklist (2026-05-20 audit)

The 2026-05 internal triage identified the following keys as already
public (baked into shipped extension/app bundles or committed to dev
env files at some point). Each must be rotated at the issuing provider
and the new value redistributed via CI secrets only — never re-pasted
into source.

| Key | Last known prefix | Issuing system | Where it appeared |
|-----|-------------------|----------------|-------------------|
| Indexer dev/prod key | `arch_live_lALR...` | Explorer Indexer admin | `apps/chrome-wallet/.env.local`, build-baked |
| Hub platform app key (current) | `OZfoD0ZJh6...` | wallet-hub-api `/v1/platform/keys` | `apps/chrome-wallet/src/state/types.ts` literal default |
| Hub platform app key (legacy) | `D3DqTHT1Jg...` | wallet-hub-api `/v1/platform/keys` | `apps/chrome-wallet/src/state/wallet-store.ts` migration constant |
| Mobile platform app key | `x7NaU5AHiZ...` | wallet-hub-api `/v1/platform/keys` | `apps/mobile-wallet/src/config.ts` literal default |

### Rotation procedure

1. Mint a fresh key in the issuing system (Hub: `POST /v1/platform/keys`;
   Indexer: admin panel).
2. Deploy the new key via the appropriate CI secret:
   - Chrome extension: GitHub Actions secrets `WXT_HUB_API_KEY` and
     `WXT_INDEXER_API_KEY` (consumed by `release-chrome-wallet.yml`).
   - Mobile wallet: EAS secrets `EXPO_PUBLIC_API_KEY` and
     `EXPO_PUBLIC_API_BASE_URL`.
3. Revoke the old key in the issuing system once the next release is
   rolled out. Existing installs auto-migrate stale-key state via the
   `migrateApiConfig` / `scrubLeakedSecrets` paths.
4. Confirm via the Hub `audit_log` table that no further requests come
   in on the revoked key.

## Hardcoded keys policy

- Never commit a literal API key, OAuth secret, or signing key to this
  repository, even as a "default".
- All build-time keys must be supplied through:
  - **Chrome extension**: `import.meta.env.WXT_*` (WXT/Vite env). Local
    dev values go in `apps/chrome-wallet/.env.local` (gitignored). See
    `apps/chrome-wallet/.env.example`.
  - **Mobile wallet**: `process.env.EXPO_PUBLIC_*`. Local dev values go
    in `apps/mobile-wallet/.env.local` (gitignored). See
    `apps/mobile-wallet/.env.example`.
  - **API service**: `services/wallet-hub-api/src/config/env.ts`,
    populated from Secrets Manager in CDK (`infra/cdk/`).
- Gitleaks + lockfile-lint + per-workspace `npm audit` run on every PR
  via `.github/workflows/security-checks.yml`; do not bypass them.
  Repo-specific gitleaks rules live in `.gitleaks.toml` at the repo
  root.

## Open hardening backlog

The full per-finding triage from the 2026-05 audit lives in
`docs/security/audit-2026-05-backlog.md`. Each row is sized to become a
GitHub Issue; please open issues from the OPEN rows before starting work
so progress is visible.

## Threat model summary

Top-level invariants the codebase enforces:

1. **Per-user isolation.** No server endpoint will sign for
   `externalUserId` X using credentials proving control of `externalUserId`
   Y. Enforced in `services/wallet-hub-api/src/routes/signingRequests.ts`
   via `assertCallerOwnsResource`.
2. **Origin-bound dApp permissions.** Browser-extension RPC calls are
   keyed by `sender.tab.url` and `sender.id === chrome.runtime.id` in
   `apps/chrome-wallet/entrypoints/background.ts`; cross-extension
   messages are rejected.
3. **Display = sign.** What the user approves in the Approve UI must
   be the byte-for-byte payload signed. Mismatch is treated as a bug,
   not a UX trade-off.
4. **Secrets never in logs.** `services/wallet-hub-api/src/audit/audit.ts`
   redacts known sensitive fields before INSERT.
