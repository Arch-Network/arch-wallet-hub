# Plan — Bridging Bitcoin runes, ordinals & inscriptions into Arch

> **Status:** Proposal / planning. No code in this repo is changed by
> this document.
>
> **Scope:** How to represent Bitcoin-native assets (runes, ordinal
> inscriptions, and — deferred — BRC-20) as first-class assets on Arch
> Network L2, and how `arch-wallet-hub` (Hub API + Chrome wallet +
> swap engine) integrates once the on-chain programs exist.
>
> **Audience:** Wallet Hub engineers + whoever owns the on-chain Arch
> programs (Satellite). Read alongside:
> - `docs/architecture.md` — Hub is a wallet↔Arch execution layer
> - `docs/spec-indexer-ordinals-runes.md` — indexer UTXO enrichment
> - `services/wallet-hub-api/docs/signing-requests.md` — signing +
>   readiness pattern

---

## 0. TL;DR / decision

1. **Three asset classes, three different paths. Do not build one
   "bridge" for all of them.**
   - **Runes → `wRUNE`** (fungible): a per-rune APL mint, peg by
     **mint-on-deposit / burn-on-withdraw** against an L1 vault.
     This is the high-value path (feeds the existing CLAMM/PropAMM
     swap stack). **Build first.**
   - **Inscriptions → 1:1 NFT receipt accounts** (non-fungible): a
     separate program; an inscription is not fungible and cannot use
     the rune mint path. **Build second, only behind a concrete Arch
     app (marketplace).**
   - **BRC-20 → defer.** Needs stateful BRC-20 indexing first
     (`docs/spec-indexer-ordinals-runes.md §3`). Out of scope v1.

2. **`arch-bridge` is the wrong tool for ingesting L1 Bitcoin
   assets, but the right *reference* for multisig governance.**
   Investigation result below (§2). It is a port of Int3face's Solana
   multisig bridge: fungible-only, `u64` amounts, asset registry +
   `2/3·n+1` voting, oriented **Arch ↔ another PoS chain** via
   off-chain attestation of an external `tx_id`. It has **no** rune,
   ordinal, inscription, runestone, or `u128` support, and **no
   on-chain Bitcoin verification** (its "Bitcoin layer" is just the
   standard Arch UTXO anchoring every account uses).

3. **Recommended on-chain model: a native `satellite_bitcoin`
   peg program, not a fork of `arch-bridge`.** Arch validators expose
   Bitcoin syscalls (`arch_get_bitcoin_tx`, `arch_validate_utxo_-
   ownership`, `arch_set_transaction_to_sign`) plus FROST/ROAST
   threshold signing of BTC transactions. That lets a peg program
   **verify the L1 rune deposit on-chain** and **co-sign the L1
   withdrawal with the network key** — strictly more trustless than
   `arch-bridge`'s off-chain observer attestation. Reuse
   `arch-bridge`'s signer-set / asset-registry / voting code as a
   pattern; do not reuse its deposit/withdraw value path.

4. **This repo (`arch-wallet-hub`) owns the integration surface, not
   the programs.** Concretely: new Hub signing actions
   (`bridge.deposit_*` / `bridge.withdraw_*`) reusing the
   `arch.anchor` readiness pattern; indexer proxy routes; swap-engine
   token-registry entries for `wRUNE`; wallet deposit/withdraw UX.

The rest of this doc is the evidence and the build plan.

---

## 1. What exists today (verified)

| Layer | State |
|---|---|
| Wallet "bridge" | UX only — connects Xverse/UniSat to Arch signing. **Not** an L1→L2 asset bridge. (`docs/architecture.md`) |
| `arch.anchor` | Binds an Arch account to a **plain** BTC UTXO for execution/confirmation gating. Not asset-aware. (`signing-requests.md`) |
| L1 in wallet | BTC send; **rune send** via runestone PSBT (`apps/chrome-wallet/src/utils/rune-psbt.ts`); inscription gallery view-only (send not implemented); UTXO protection (`apps/chrome-wallet/src/utils/btc-protection.ts`) keeps inscribed/runed UTXOs out of coin selection |
| L2 in wallet | `arch.transfer`, APL token transfer, CLAMM/PropAMM swap (`packages/arch-swap-engine`, `apps/chrome-wallet/src/pages/Swap`) |
| Indexer | Spec'd in `docs/spec-indexer-ordinals-runes.md`; Hub proxies Titan routes (`services/wallet-hub-api/src/routes/indexer.ts`). Phase-1 UTXO enrichment is the dependency for everything here |

**Implication:** the wallet can already *hold and move* runes/
inscriptions on L1. What's missing is an **L2 representation** and the
**peg machinery** that connects the two.

---

## 2. `arch-bridge` investigation (now public)

Repo: `Arch-Network/arch-bridge` — deployed program id
`adf903bc81db1885e898c3ce9200c8e0d7264376883adce31d8f3ba2b5918d75`.

**What it is:** a Satellite (Anchor-equivalent) port of
[Int3face's solana-bridge](https://github.com/Int3facechain/solana-bridge),
claiming 100% functional parity.

**Core model (from `src/state/models.rs`, `src/instructions/`):**
- `Bridge` account holds a signer set (max 10), an asset registry
  (max 30 `Asset`), and pending/finalized request queues.
- `Asset.asset_type ∈ { NATIVE, SPL, SPL_OWNED }`,
  `supply: u64`, `min_transfer_amount: u64`,
  `dest_chain_ids: [[u8;15]; 15]`.
- **Deposit** (`deposit_native` / `deposit_spl`): pulls an *Arch-side*
  asset into the vault PDA. `SPL_OWNED` ⇒ **burn**; `SPL`/`NATIVE` ⇒
  **lock**. Args include `dest_chain_id: [u8;15]` + `recipient:
  String` → signal to an off-chain relayer.
- **Withdraw** (`withdraw_native` / `withdraw_spl`): multisig. Signers
  vote keyed on an external `tx_id: [u8;32]`; at threshold
  `(2·n)/3 + 1` it releases (`SPL`/`NATIVE`) or **mints**
  (`SPL_OWNED`) to the recipient on Arch.
- Governance: `add_assets`, `remove_asset`, `update_signers`,
  `update_params`, `update_status`, `prune`, `upgrade`/`migrate` — all
  multisig-voted.

**What it is NOT (the disqualifiers for our use case):**
- ❌ No runes: no `rune_id`, no `u128` amounts (rune amounts are u128;
  `supply`/amounts here are `u64`), no runestone parsing.
- ❌ No ordinals/inscriptions: fungible-only, no 1:1 / NFT / satpoint
  concept.
- ❌ No **on-chain** Bitcoin verification. Per
  `docs/SOLANA_BRIDGE_TO_ARCH_BRIDGE_PORTING.md`, its "Bitcoin layer"
  is the generic Arch **anchoring/finality** (FROST/ROAST + Titan
  ownership checks) shared by all accounts — not bridge-specific L1
  asset ingestion. The withdraw leg trusts off-chain signer
  attestation of `tx_id`, not a verified L1 transaction.
- ❌ Orientation is **Arch → another chain** (`dest_chain_id`,
  `recipient_chain: u16`), i.e. exporting Arch assets out, the
  opposite of pulling L1 Bitcoin-native assets in.

**Verdict:** Reuse as a **pattern reference** for the signer set,
asset registry, and `2/3·n+1` voting/queue mechanics. Do **not** fork
its value path for runes or ordinals.

---

## 3. Trust model

All three asset classes share one custody question: **who controls the
L1 UTXO while the L2 representation exists?**

- **Best (Arch-native):** the L1 vault address is the Arch **network
  FROST key**. A peg program verifies deposits on-chain via
  `arch_get_bitcoin_tx` and authorizes withdrawals by building the L1
  spend with `arch_set_transaction_to_sign`, co-signed by the
  validator set (ROAST). No standalone federation. This is the model
  Arch's own guides (runes swap / BTC lending) point at.
- **Fallback (federation):** an `m-of-n` FROST/multisig federation
  holds the vault and attests deposits off-chain (the `arch-bridge`
  model). Weaker (liveness + honest-majority assumptions on the
  federation), but ships without core protocol dependencies.

**Decision needed from Arch core (§9):** is the network FROST key
usable as a program-controlled vault for an app-deployed peg program,
or must we run a federation? This single answer determines whether the
peg is trust-minimized or federated.

---

## 4. Runes → `wRUNE` (build first)

### 4.1 Representation
- One APL mint per `rune_id` (`block:tx`), e.g. `wRUNE:840000:1`.
- Decimals = the rune's `divisibility`.
- **u128 problem:** rune amounts are `u128`; APL/`arch-bridge` use
  `u64`. Resolve before coding: either (a) confirm APL mints support
  `u128` supply/amounts, or (b) cap pegged amounts to `u64` and reject
  deposits that would overflow (document the cap), or (c) scale by
  divisibility so realistic balances fit `u64`. **Must be decided with
  Arch core — do not silently truncate u128.**

### 4.2 Deposit (L1 rune → L2 `wRUNE`)
1. Wallet builds a runestone PSBT (reuse `rune-psbt.ts`) sending the
   rune to the **vault** address, with a deposit memo binding it to the
   user's Arch account.
2. User signs + broadcasts on L1 (existing send pipeline).
3. Peg program verifies the L1 tx (native syscall) — correct
   `rune_id`, amount, vault output, confirmations — then **mints**
   `wRUNE` to the user's Arch account.
4. Hub surfaces this as a signing request with **readiness** gated on
   BTC confirmations (reuse `BTC_MIN_CONFIRMATIONS` + the
   `readiness` polling from `signing-requests.md`).

### 4.3 Withdraw (L2 `wRUNE` → L1 rune)
1. User submits a withdraw request on L2; program **burns** `wRUNE`.
2. Program constructs the L1 runestone-encoded payout from the vault
   (`arch_set_transaction_to_sign`); validator set co-signs (ROAST);
   tx broadcast to the user's L1 address.

### 4.4 DEX wiring (the actual payoff)
- Register each `wRUNE` mint in
  `packages/arch-swap-engine/src/lib/network/{mainnet,testnet}.ts`
  `tokens`. **Note:** `TokenSymbol` is currently a closed union
  (`"BTC" | "USDC" | "USDT"`) in `network/types.ts` — extend to admit
  dynamic rune symbols (likely `string` + a `kind: "rune"` discriminant
  on `TokenInfo`, carrying `runeId`/`divisibility`).
- Create CLAMM pools `wRUNE ↔ aBTC` / `wRUNE ↔ USDT`.
- Surface `wRUNE` in `Swap.tsx` token picker; product framing:
  *"Deposit runes, swap vs aBTC/stables on Arch."*

---

## 5. Inscriptions / ordinals → 1:1 NFT receipts (build second)

**Only build this behind a concrete Arch app (the marketplace).**
Bridging JPEGs for their own sake is a weak use case — collectors want
L1 provenance.

### 5.1 Representation
- One Arch account per `inscription_id` (a non-fungible receipt), not
  a fungible mint. **Separate program from the rune peg.**
- Deposit PSBTs must be **satpoint-aware** (move exactly the inscribed
  sat without disturbing others on the same output) — depends on
  indexer `GET /bitcoin/output/:outpoint` and inscription `satpoint`
  (`docs/spec-indexer-ordinals-runes.md §2B/§2F`). The wallet's
  inscription **send** flow (currently stubbed) is a prerequisite.

### 5.2 Decentralized marketplace on Arch (the use case)
- Marketplace program: list / buy / cancel / royalties; atomic
  "pay in USDT/aBTC **and** transfer the NFT receipt account."
- **Trust caveat:** settlement of the *receipt* is trustless on Arch,
  but the L1 inscription still sits in the vault (federation/FROST) —
  this is custodial-at-the-vault, not fully trustless L1 custody. State
  this plainly in product copy.

---

## 6. Wallet Hub integration surface (this repo)

When the programs exist, work in `arch-wallet-hub` is additive:

| Area | Change |
|---|---|
| Signing actions | Add `bridge.deposit_rune`, `bridge.withdraw_rune` (and later `bridge.deposit_inscription`, marketplace `list`/`buy`) to `services/wallet-hub-api/src/routes/signingRequests.ts`, following the existing `action.type` switch + `display` preview pattern |
| Readiness | Reuse the `arch.anchor` readiness machinery (`BTC_MIN_CONFIRMATIONS`, `GET /v1/signing-requests/:id` → `readiness`) to gate mint-on-deposit on BTC confirmations |
| Indexer proxy | Ship the Phase-2 proxy routes (`/runes`, `/inscriptions`, `/output/:outpoint`) in `src/routes/indexer.ts` so the wallet can read rune balances + satpoints |
| Swap engine | Extend `TokenInfo`/`TokenSymbol` + `tokens` map for `wRUNE`; register CLAMM pools |
| Chrome wallet | "Deposit rune" flow; `wRUNE` in token picker/Swap; marketplace flows on `Collectibles.tsx`; finish the stubbed inscription send |

No change to the core architecture in `docs/architecture.md`: the Hub
stays an execution/data layer; the peg lives in Arch programs.

---

## 7. Build order (verifiable phases)

**Phase 0 — Safety & prerequisites (unblocked, Wallet Hub owned)**
- Ship indexer Phase 1 UTXO enrichment + Hub proxy → *verify:*
  `btc-protection.ts` partitions real inscribed/runed UTXOs out of
  coin selection against a live address.
- Finish L1 inscription **send** (satpoint-aware) → *verify:* a single
  inscription moves without disturbing co-located sats on testnet.

**Phase 1 — Rune peg + DEX (highest value)**
- Confirm vault custody model + u128 handling with Arch core (§9).
- Peg program: deposit-verify + mint, burn + withdraw-cosign.
- Hub `bridge.deposit_rune` / `bridge.withdraw_rune` + readiness.
- `wRUNE` in swap engine + one CLAMM pool. → *verify:* round-trip a
  testnet rune L1→`wRUNE`→swap→`wRUNE`→L1 with conserved balances.

**Phase 2 — Inscription receipts + marketplace**
- NFT receipt program + satpoint-aware deposit PSBTs.
- Marketplace program (atomic pay + receipt transfer).
- Wallet marketplace UX. → *verify:* list + buy settles atomically on
  testnet; withdraw returns the L1 inscription intact.

**Phase 3 — Hardening / BRC-20**
- Audit vault custody; BRC-20 only if indexer adds BRC-20 state.

---

## 8. Why not just reuse `arch-bridge`? (explicit tradeoff)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Fork `arch-bridge` for runes | Existing multisig/voting/asset registry, tested | `u64` (rune u128), fungible-only, off-chain attestation (less trustless than native), wrong orientation, no runestone/BTC verify; heavy retrofit | ❌ Not for the value path |
| **Native `satellite_bitcoin` peg program** | On-chain L1 verification, network-FROST custody = more trustless, idiomatic Arch, matches Arch's own rune/lending guides | New program; depends on core syscalls + vault-key answer | ✅ **Recommended** |
| Federation peg (no core dep) | Ships without protocol changes | Honest-majority + liveness assumptions on federation | ⚠️ Fallback if core vault key unavailable |

Inscriptions need a **separate NFT + marketplace program** regardless —
no version of `arch-bridge` represents non-fungibles.

---

## 9. Open questions for Arch core (blocking Phase 1)

1. **Vault custody:** can an app-deployed peg program control an L1
   vault via the network FROST key (`arch_set_transaction_to_sign` +
   ROAST), or must we run a federation? (Decides §3.)
2. **u128:** do APL mints support `u128` amounts/supply, or must
   `wRUNE` cap to `u64`? (Decides §4.1.)
3. **Canonical programs:** does Arch core intend to ship a canonical
   rune-peg / `wRUNE` program (and who deploys mint authorities + CLAMM
   pools), or is this app-owned? (`arch-bridge` is cross-chain, so this
   is genuinely open.)
4. **Marketplace:** core-delivered or app-owned program?

---

## 10. One-line summary

`arch-bridge` is a fungible, `u64`, off-chain-attested **Arch→other-
chain** multisig bridge — useful only as a governance pattern. For DEX
runes, build a **native `satellite_bitcoin` `wRUNE` peg** (mint-on-
deposit / burn-on-withdraw, network-FROST vault) and wire it into the
existing CLAMM + swap engine; for ordinals, build **separate NFT +
marketplace programs**; defer BRC-20. Confirm vault custody + u128 with
Arch core before Phase 1.
