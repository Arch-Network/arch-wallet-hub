# Indexer API spec — UTXO ordinals/runes/BRC-20 support

> **Audience:** AI coding agent (or engineer) building out the Arch
> indexer API (the service hosted at `explorer.arch.network/api/v1`,
> a typed REST wrapper around the Titan BTC indexer).
>
> **Consumer of this API:** The Arch Wallet Hub
> (`services/wallet-hub-api`) proxies these endpoints to the
> chrome-wallet (`apps/chrome-wallet`). The wallet routes 100% of its
> indexer traffic through the Hub (see PR #20 + #21).
>
> **Source of truth for raw data:** The Titan indexer
> (https://github.com/SaturnBTC/titan). Titan already indexes
> inscriptions and runes natively, including mempool-level resolution.
> The work below is exposing that data through the existing wrapper's
> typed surface, NOT building a new indexer.

---

## 0. Context

### What exists today

The Arch indexer at `explorer.arch.network/api/v1` exposes a typed
subset of Titan focused on the BTC-anchor data Arch L2 operations
need:

- `GET /bitcoin/address/:address` — summary (funded, spent, count)
- `GET /bitcoin/address/:address/utxo` — plain UTXO list
- `GET /bitcoin/address/:address/txs` — tx history
- `GET /bitcoin/tx/:txid` — tx detail
- `GET /bitcoin/tx/:txid/status` — confirmation status
- `GET /bitcoin/block/:hash`, `/block-height/:h`, `/tip`
- `GET /bitcoin/fee-estimates`
- `POST /bitcoin/tx` — broadcast

Auth: `Authorization: Bearer <indexer-key>` AND `X-API-Key: <indexer-key>`
(both required by current callers). All new endpoints inherit the
same auth.

### What's missing

None of Titan's inscription, rune, or per-output endpoints are exposed
through this wrapper. As a result, the wallet has no way to identify
which UTXOs are encumbered by inscriptions or runes, and a naive coin
selection (largest-first) can consume a $5,000 Ordinal as fee fodder.

### What the wallet will do with this data

**Phase 1** (wallet PR ships after endpoints land):
- Filter encumbered UTXOs out of BTC coin selection by default
- Show "Spendable BTC" vs "Protected (inscriptions/runes)" split on
  Dashboard
- Send page MAX uses spendable balance, not total

**Phase 2** (wallet PR follows):
- Token list shows rune balances alongside Arch APL tokens
- Inscriptions gallery view
- Per-rune detail page (history, decimals, supply)
- "Send Rune" flow (runestone-encoded transfer)
- "Send Inscription" flow (satpoint-aware coin selection)
- History tab adds chips for rune transfers and inscription
  movements

---

## 1. Phase 1 — UTXO enrichment (CRITICAL)

This is the minimum the wallet needs to start protecting users. Ship
this alone if you ship nothing else.

### 1A. Enrich `GET /bitcoin/address/:address/utxo`

Augment each item with **two optional fields**:

```jsonc
[
  {
    "txid": "abc...",
    "vout": 0,
    "value": 250000,
    "status": { "confirmed": true, "block_height": 873421 },

    // NEW — present only if the output carries inscriptions
    "inscriptions": [
      { "id": "5e3c...i0" }
    ],

    // NEW — present only if the output carries any rune balance
    "runes": [
      {
        "rune_id": "840000:1",
        "spaced_name": "UNCOMMON\u2022GOODS",
        "amount": "1000000"
      }
    ]
  }
]
```

**Field rules:**

- Both `inscriptions` and `runes` are **optional**. Omit entirely on
  plain BTC outputs — do NOT return `inscriptions: []` or `runes: []`
  on empty cases. Saves payload, lets clients do a cheap
  `if ("inscriptions" in utxo)` guard.
- `inscriptions[].id` is the Ordinal inscription ID
  (`<txid>i<index>`). Other inscription metadata (content, MIME,
  collection) is fetched lazily via Phase 2 endpoints.
- `runes[].rune_id` is the canonical `block:tx` rune identifier from
  Titan.
- `runes[].spaced_name` is the human-readable spaced rune name with
  the U+2022 bullet separator (e.g. `UNCOMMON•GOODS`).
- `runes[].amount` MUST be a **decimal string**, not a JSON number.
  Rune amounts are u128 internally — JSON numbers lose precision above
  2^53. This is non-negotiable.

**Backwards compatibility:**

- Existing clients (including the deployed wallet today) MUST
  continue to work unmodified. Both new fields being optional
  guarantees this.
- Our `BtcUtxo` TS type already has `[k: string]: unknown` index
  signature; adding fields is non-breaking.

### 1B. Spendable/protected split on `GET /bitcoin/address/:address`

Add two precomputed sums to the address-summary response:

```jsonc
{
  // ... existing fields (funded, spent, tx_count, etc.) ...
  "spendable_value": 145000,
  "protected_value": 50000
}
```

**Field rules:**

- `spendable_value`: sats sum across UTXOs with no inscriptions AND
  no rune balance.
- `protected_value`: sats sum across UTXOs carrying at least one
  inscription OR at least one rune balance.
- `spendable_value + protected_value` MUST equal
  `(funded - spent)` from the existing summary fields. Treat this as
  a server-side invariant.
- Both fields are sats integers (safe in JSON number range for any
  realistic address).

This is precomputed so the wallet's Dashboard doesn't have to fetch
the full UTXO list just to render a balance split.

### 1C. Acceptance tests for Phase 1

A `curl` against the indexer for a test address that holds at least
one inscribed UTXO, at least one runed UTXO, and at least one plain
UTXO returns:

- ✅ Plain BTC UTXOs with no `inscriptions` and no `runes` keys
- ✅ Inscribed UTXOs with `inscriptions: [{id: ...}]` and no `runes`
  key
- ✅ Runed UTXOs with `runes: [{rune_id, spaced_name, amount}]` and
  no `inscriptions` key
- ✅ Outputs carrying both: both fields populated
- ✅ Address summary `spendable_value + protected_value === funded - spent`
- ✅ Existing clients that don't know about the new fields keep
  working (regression test on the existing wallet build)

---

## 2. Phase 2 — Full rune/inscription/BRC-20 surfacing

These endpoints unblock the wallet's Phase 2 UI (token list with
runes, inscription gallery, send flows). Ship them after Phase 1 is
green.

### 2A. `GET /bitcoin/address/:address/runes`

Aggregated rune balances per address.

**Response:**

```jsonc
{
  "address": "bc1p...",
  "balances": [
    {
      "rune_id": "840000:1",
      "spaced_name": "UNCOMMON\u2022GOODS",
      "amount": "1000000",
      "divisibility": 0,
      "symbol": "\u2615"
    },
    {
      "rune_id": "840001:5",
      "spaced_name": "DOG\u2022GO\u2022TO\u2022THE\u2022MOON",
      "amount": "5000000000000",
      "divisibility": 5,
      "symbol": "\ud83d\udc15"
    }
  ]
}
```

**Field rules:**

- `amount` is the raw u128 sum across all UTXOs as a **decimal
  string**. Frontend applies `divisibility` to render
  human-readable.
- `divisibility` is u8 (0..38 in practice). Decimal places to apply
  when rendering.
- `symbol` is optional. Single Unicode code point per Runes spec.
- Sort by `amount` desc by default. Pagination not required for
  Phase 2; addresses with thousands of distinct runes are rare
  enough that returning the full list is fine.

### 2B. `GET /bitcoin/address/:address/inscriptions`

Inscriptions held by the address.

**Query params:**

- `limit` (optional, default 50, max 200)
- `cursor` (optional, opaque pagination token)

**Response:**

```jsonc
{
  "inscriptions": [
    {
      "id": "5e3c...i0",
      "number": 12345678,
      "satpoint": "abc...:0:0",
      "content_type": "image/webp",
      "content_length": 4823,
      "genesis_height": 832145,
      "genesis_fee": 1024,
      "owner": "bc1p..."
    }
  ],
  "next_cursor": null
}
```

**Field rules:**

- `id`: standard `<txid>i<index>` inscription ID
- `number`: sequential index across all inscriptions (negative for
  cursed); useful for sort + dedupe
- `satpoint`: `<txid>:<vout>:<sat_offset>` indicating which sat in
  which output currently carries the inscription. CRITICAL for send
  flows — the wallet uses this to construct a transaction that moves
  exactly one inscription without disturbing others on the same
  output.
- `content_type` may be null/missing for legacy inscriptions; client
  treats absent as `application/octet-stream`.
- `next_cursor` is null when there are no more pages.

### 2C. `GET /bitcoin/runes/:rune`

Rune metadata.

**Path param:** `:rune` accepts EITHER the rune name (spaced form
URL-encoded, e.g. `UNCOMMON%E2%80%A2GOODS`) OR the rune ID
(`840000:1`).

**Response:**

```jsonc
{
  "rune_id": "840000:1",
  "spaced_name": "UNCOMMON\u2022GOODS",
  "name": "UNCOMMONGOODS",
  "number": 1,
  "divisibility": 0,
  "symbol": "\u2615",
  "etching_txid": "abc...",
  "etching_height": 840000,
  "premine": "0",
  "max_supply": "340282366920938463463374607431768211455",
  "minted": "1234567890",
  "burned": "0",
  "circulating": "1234567890",
  "mints_remaining": "338..."
}
```

**Field rules:**

- All numeric supplies are **decimal strings** (u128 range).
- `mints_remaining` can be null/missing for runes with no terms or
  unlimited mints.
- `circulating = minted - burned`.

### 2D. `GET /bitcoin/inscriptions/:id`

Inscription metadata. Path param is the inscription ID.

**Response:**

```jsonc
{
  "id": "5e3c...i0",
  "number": 12345678,
  "satpoint": "abc...:0:0",
  "content_type": "image/webp",
  "content_length": 4823,
  "content_url": "/bitcoin/inscriptions/5e3c...i0/content",
  "genesis_height": 832145,
  "genesis_tx": "abc...",
  "genesis_fee": 1024,
  "owner": "bc1p...",
  "collection": {
    "id": "bitcoin-puppets",
    "name": "Bitcoin Puppets"
  },
  "parent_inscription_id": null,
  "delegate_inscription_id": null,
  "sat_rarity": "common"
}
```

**Field rules:**

- `content_url` is a relative URL to the streaming content endpoint
  (2E). Client resolves against `INDEXER_BASE_URL`.
- `collection` is optional; populate when the inscription is part of
  a known collection registry. Phase 2 wallet ignores unknown
  collections.
- `parent_inscription_id` / `delegate_inscription_id` are optional
  Ordinals features; wallet renders them only if present.

### 2E. `GET /bitcoin/inscriptions/:id/content`

Inscription content stream.

- Returns raw bytes with proper `Content-Type` and `Content-Length`
  headers from the inscription envelope.
- Should support HTTP `Range` requests (Titan likely supports this
  natively for large content; pass-through is fine).
- Cache-Control: `public, max-age=31536000, immutable` (inscriptions
  are immutable by definition).
- Auth: same as other endpoints. The wallet streams via the Hub
  proxy; consider whether bypass is desired for large media.

### 2F. `GET /bitcoin/output/:outpoint`

Per-output detail. Path param `:outpoint` is `txid:vout` (colon
separator, URL-encoded).

**Response:**

```jsonc
{
  "txid": "abc...",
  "vout": 0,
  "value": 250000,
  "address": "bc1p...",
  "spent": false,
  "spent_by_txid": null,
  "inscriptions": [
    {
      "id": "5e3c...i0",
      "satpoint": "abc...:0:0",
      "content_type": "image/webp"
    }
  ],
  "runes": [
    {
      "rune_id": "840000:1",
      "spaced_name": "UNCOMMON\u2022GOODS",
      "amount": "1000000"
    }
  ]
}
```

Used by the wallet for:
- "Tap an inscribed UTXO to see what's on it" UX
- Satpoint derivation when constructing inscription transfer
  transactions
- Post-broadcast confirmation that a specific output landed on the
  right address

### 2G. `GET /bitcoin/address/:address/rune-transactions`

Address-scoped rune transfer history. Used by the History tab to
label rune mint / transfer / etch events.

**Query params:**

- `limit` (optional, default 50, max 200)
- `cursor` (optional)
- `rune_id` (optional filter to a single rune)

**Response:**

```jsonc
{
  "transactions": [
    {
      "txid": "abc...",
      "block_height": 870123,
      "timestamp_ms": 1716929400000,
      "kind": "transfer",
      "rune_id": "840000:1",
      "spaced_name": "UNCOMMON\u2022GOODS",
      "delta": "-1000000",
      "counterparty": "bc1p..."
    }
  ],
  "next_cursor": null
}
```

**Field rules:**

- `kind` ∈ `"etch" | "mint" | "transfer" | "burn"`.
- `delta`: signed decimal string. Positive = inbound to `:address`,
  negative = outbound.
- `counterparty` is optional and best-effort. Self-sends or
  multi-counterparty transfers may omit.

---

## 3. BRC-20 — open question

Titan supports inscriptions and Runes natively. **BRC-20 is a
separate protocol** built on top of text-content inscriptions
(`{"p":"brc-20","op":"mint","tick":"ordi","amt":"1000"}` etc.) that
requires a stateful indexer to track per-address balances.

**Question for indexer owner:** Does Titan (or your wrapper) already
maintain BRC-20 state, or is that a separate effort?

If yes: please add equivalent endpoints for BRC-20:

- `GET /bitcoin/address/:address/brc20` — aggregated BRC-20 balances
  with `transferable` (locked) vs `available` split (BRC-20's two-
  phase send model is non-obvious; this split is essential).
- `GET /bitcoin/brc20/:tick` — token metadata (max_supply, minted,
  limit_per_op, decimals).
- `GET /bitcoin/address/:address/brc20-transactions` — history.
- Augment Phase 1 UTXO enrichment with an optional `brc20` field on
  outputs that carry a `transferable` BRC-20 inscription (these MUST
  be filtered out of coin selection alongside inscriptions/runes).

If BRC-20 indexing is out of scope: the wallet defers BRC-20 entirely
to a Phase 3.

---

## 4. API conventions (all new endpoints)

### Auth

Same as existing endpoints:
- `Authorization: Bearer <indexer-key>`
- `X-API-Key: <indexer-key>`

Either present is sufficient; current callers send both.

### Errors

Match the existing error envelope. The wrapper currently returns:

```jsonc
{
  "error": "missing_credentials",
  "message": "Authentication is required. Provide an API key via Authorization / X-API-Key or a valid session cookie."
}
```

For new endpoints:

| Condition | HTTP | `error` code |
|---|---|---|
| Missing auth | 401 | `missing_credentials` |
| Bad auth | 401 | `invalid_credentials` |
| Rate limited | 429 | `rate_limit_exceeded` |
| Resource not found (rune/inscription/output) | 404 | `not_found` |
| Bad path param (malformed inscription ID, bad address) | 400 | `bad_request` |
| Upstream Titan unavailable | 502 | `upstream_unavailable` |

### Pagination

Use opaque cursor pagination for list endpoints:

- Request: `?limit=N&cursor=<opaque>`
- Response: `{ ..., "next_cursor": "<opaque>" | null }`

Cursors are not page numbers — they are server-defined tokens
(usually base64-encoded `(last_id, last_ts)` or similar). This avoids
deep-pagination perf cliffs and lets the indexer evolve internals
without breaking clients.

### Decimal strings

ALL u128 values (rune amounts, BRC-20 amounts, max supplies, mints)
MUST be decimal strings. Never JSON numbers. The wallet treats them
as `bigint` once parsed.

Sats values stay JSON numbers — Bitcoin's 21M cap × 1e8 = 2.1e15 fits
in a JS Number safely (Number.MAX_SAFE_INTEGER ≈ 9e15).

### Rate limits

Same rate-limit posture as existing endpoints. The Wallet Hub adds a
per-installation rate-limit shard on top via `x-arch-install-id`, so
indexer-level limits can stay coarse.

---

## 5. Out of scope (do NOT build in this batch)

- Marketplace / listings (signed PSBT listings, auction state)
- DeFi / AMM rune trading endpoints
- Address-rune-balance-at-block-height (historical snapshots)
- BTC mempool fee bumping helpers (CPFP / RBF planning)
- Inscription content generation / preview thumbnails (just stream
  raw content; client renders)
- Collection registry curation (just return collection ID if Titan
  knows; don't curate)
- Webhooks / push notifications (wallet uses polling for now)
- Multi-address batch queries (one address per call is fine)

If a question comes up about something not in this spec, stop and
ask. Don't expand scope unilaterally.

---

## 6. Phased delivery checklist

### Phase 1 — minimum viable
- [ ] `GET /bitcoin/address/:address/utxo` returns optional
  `inscriptions[]` and `runes[]` fields on enriched outputs
- [ ] `GET /bitcoin/address/:address` returns `spendable_value` and
  `protected_value`
- [ ] Acceptance tests pass (§1C)
- [ ] Existing wallet build (v0.4.0) still works against the new
  indexer (regression check)

### Phase 2 — full surfacing
- [ ] `GET /bitcoin/address/:address/runes`
- [ ] `GET /bitcoin/address/:address/inscriptions` (paginated)
- [ ] `GET /bitcoin/runes/:rune`
- [ ] `GET /bitcoin/inscriptions/:id`
- [ ] `GET /bitcoin/inscriptions/:id/content` (streaming, immutable
  cache)
- [ ] `GET /bitcoin/output/:outpoint`
- [ ] `GET /bitcoin/address/:address/rune-transactions` (paginated)
- [ ] BRC-20 endpoints (only if Titan/wrapper has BRC-20 state; ask
  first)

---

## 7. Coordination with the wallet team

The wallet PR for Phase 1 ships in parallel under the name
`feat(chrome-wallet): UTXO protection scaffolding`. It will land
**before** your endpoint changes go live, in a no-op safe mode that
treats every UTXO as plain. The instant your enriched UTXO endpoint
returns the new fields in production, wallet behavior switches over
automatically — no wallet redeploy needed.

The Phase 2 wallet PR(s) will wait for your Phase 2 endpoints to be
green in production before merging. Send notification (or just open a
PR against `arch-wallet-hub` adding the corresponding Hub proxy
routes — that's the cleanest signal that the data is ready).

---

## 8. Style / engineering notes for the implementing agent

- Stay **surgical**. Don't refactor adjacent endpoints, don't add
  new abstraction layers, don't introduce a "v2" namespace. Each
  new endpoint is a small addition to the existing wrapper using
  the same patterns.
- Match the **existing TypeScript/route style** of the wrapper.
  If the wrapper uses TypeBox schemas like our Hub does, define
  TypeBox schemas for every new endpoint. If it uses Zod or
  hand-rolled, match that.
- **Don't change auth, error envelope, or pagination conventions**
  globally to fit new endpoints. If the existing conventions don't
  fit, surface the conflict and ask — don't unilaterally change
  the existing surface.
- Wire each endpoint as a thin pass-through to Titan's
  corresponding API where possible. Add server-side caching only
  if Titan's response time on an endpoint is consistently >500ms
  (most aren't).
- Write integration tests for at least Phase 1's acceptance
  criteria (§1C). Hitting Titan in CI is fine if there's a stable
  testnet address with known inscriptions/runes; otherwise mock
  Titan responses.
- **Don't break the existing surface.** Run any pre-existing
  integration test suite before opening the PR.
