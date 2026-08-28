# Token-price service (design)

> Status: **proposal** — no code yet. This doc proposes a shared
> price/valuation service inside the Wallet Hub API
> (`services/wallet-hub-api`). It is the source of truth for the API
> surface, data-source strategy, and rollout; review and amend before
> any implementation PR.

## Problem

Every frontend computes USD prices itself, and each one **hardcodes
CoinGecko**:

| Client | File | What it does |
|--------|------|--------------|
| Chrome wallet | `apps/chrome-wallet/src/utils/btc-price.ts` | `GET api.coingecko.com/.../simple/price?ids=bitcoin` |
| Chrome wallet | `apps/chrome-wallet/src/utils/prices.ts` | CoinGecko for `bitcoin` + `arch-network`; APL tokens read `usd_price` off indexer token metadata; 5-min cache in `chrome.storage.local` |
| Swap engine | `packages/arch-swap-engine/src/lib/wallet/btc-price.ts` | CoinGecko BTC fallback inside `quote-client.ts` |

This is the duplication Abhay/Deepanshu want gone. The source, the API
key, the cache TTL, the id→symbol mapping, and the
"what-do-we-do-when-it's-down" logic all live in **three** places (soon
four, once iOS and Arch Prime want the same numbers). Changing the
upstream from CoinGecko to anything else is a multi-repo, multi-release
migration. There is no shared cache, so N clients × M installs each hit
CoinGecko's free tier directly and share its anonymous rate limit.

The Hub already owns the analogous problem for indexer reads: the
privileged key used to ship in the extension bundle, got leaked, and got
rate-limited in the wild. The fix was to move the key server-side and
expose typed `/v1/indexer/*` proxy routes (see
`services/wallet-hub-api/src/routes/indexer.ts`). **Prices are the same
shape of problem and should get the same shape of fix.**

## Goal & non-goals

**Goals**

- One Hub-owned endpoint that returns the **current** USD price of the
  assets the wallet actually shows, so the extension, iOS, and any web
  frontend (Arch Prime) stop talking to CoinGecko directly.
- Own the upstream choice, the API key, the cache, and the
  id-mapping in **one** place behind a stable wire contract.
- Cover the full set of assets the wallet displays balances for — not
  just BTC — including arch-native tokens that external APIs don't list.
- Be a good upstream citizen: shared server-side cache so we make far
  fewer upstream calls than N clients would.

**Non-goals**

- Not a trading/oracle-grade price feed. These prices drive **portfolio
  display** ("your wallet is worth ~$X") and swap-screen *estimates*, not
  settlement, liquidations, or anything where being wrong costs money.
  Swap execution already gets exact amounts from the PropAMM quote
  endpoint; this service does not replace that.
- Not historical charts / OHLC in v1 (current spot only; `asOf` provided
  so clients can show "as of HH:MM").
- Not per-user or sensitive data — see Auth.

## Where it lives

A new route module `services/wallet-hub-api/src/routes/prices.ts`
registered with the `/v1` prefix in `server.ts`, plus a
`src/prices/` directory for the provider/cache logic (mirrors how
`src/indexer/` backs `routes/indexer.ts`). It reuses the existing
plugins verbatim: `appAuth` (API-key gate), `getDbPool` /
`withDbTransaction` for the cache table, the `@fastify/rate-limit`
per-route override pattern, the `request.completed` observability hook,
and TypeBox route schemas that feed `@fastify/swagger`.

## Assets we must price

What the wallet renders balances for today, and therefore what the
service must value:

| Asset class | Identifier in our system | Source of balance | External listing? |
|-------------|--------------------------|-------------------|-------------------|
| **BTC** | `btc` | indexer BTC address summary (sats) | yes (CoinGecko `bitcoin`) |
| **ARCH** (native gas, 8 decimals) | `arch` | indexer account summary (lamports) | maybe (CoinGecko `arch-network` — *may not be listed yet*) |
| **APL tokens** (arch-native, SPL-like) | `apl:<mint_address>` | indexer `/accounts/:addr/tokens` (`mint_address`, `decimals`) | almost never |
| **Runes** (BTC L1) | `rune:<rune_id>` | indexer `/bitcoin/address/:addr/runes` (`rune_id`, `spaced_name`, `divisibility`, u128 `amount`) | rarely on CoinGecko |

The important consequence: **external price APIs cover at most BTC and
maybe ARCH.** APL tokens and most runes are not on CoinGecko, so a
CoinGecko-only service would leave most of the wallet "unpriced" — the
exact state `prices.ts` is stuck in today (`unpriced: true` for every
APL token). The data-source strategy below addresses this directly.

## Proposed API surface

Two endpoints. One is the primitive (prices); the other is a
convenience (wallet value) we can ship later.

### `GET /v1/prices`

Batch spot lookup. The id namespace matches the table above.

Query (TypeBox):

```ts
const PricesQuery = Type.Object({
  ids: Type.String({ minLength: 1, maxLength: 4096 }), // CSV: "btc,arch,apl:<mint>,rune:<rune_id>"
  vs: Type.Optional(Type.Union([Type.Literal("usd")], { default: "usd" })),
});
```

Network is taken from the existing `x-network` header (`testnet` |
`mainnet`), same convention as the indexer routes — testnet prices are
mostly meaningless and the service should return `null`/`stale` rather
than fake numbers (the current BTC code already refuses to show USD on
testnet).

Response (TypeBox):

```ts
const PricePoint = Type.Object({
  id: Type.String(),
  vs: Type.String(),                                  // "usd"
  price: Type.Union([Type.Number(), Type.Null()]),    // null = couldn't price it
  change24hPct: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  asOf: Type.String({ format: "date-time" }),         // when this price was sourced
  stale: Type.Boolean(),                              // true => older than the freshness budget
  source: Type.String(),                             // "coingecko" | "amm" | "indexer" | "none"
});

const PricesResponse = Type.Object({
  vs: Type.String(),
  prices: Type.Array(PricePoint),
});
```

Example:

```http
GET /v1/prices?ids=btc,arch,apl:9xQ...mint,rune:840000:3 HTTP/1.1
x-api-key: <app key>
x-network: mainnet
```

```json
{
  "vs": "usd",
  "prices": [
    { "id": "btc",  "vs": "usd", "price": 64210.5, "change24hPct": 1.8, "asOf": "2026-06-21T11:30:02Z", "stale": false, "source": "coingecko" },
    { "id": "arch", "vs": "usd", "price": 0.482,   "change24hPct": -3.1, "asOf": "2026-06-21T11:30:02Z", "stale": false, "source": "coingecko" },
    { "id": "apl:9xQ...mint", "vs": "usd", "price": 0.00031, "asOf": "2026-06-21T11:29:40Z", "stale": false, "source": "amm" },
    { "id": "rune:840000:3", "vs": "usd", "price": null, "asOf": "2026-06-21T11:30:02Z", "stale": true, "source": "none" }
  ]
}
```

Rules:

- The response always echoes **every** requested id. Unpriceable ids
  come back `price: null, source: "none"` rather than being dropped —
  clients render "—" instead of guessing.
- Unknown/oversized ids are skipped server-side (no upstream
  amplification); the response still lists them as `null`.

### `POST /v1/wallet/value` (v2 — convenience)

Server-side valuation so thin clients (iOS, web) don't reimplement the
"balances × prices, with unpriced footnote" math that already exists in
`prices.ts` (`valuatePortfolio`). Takes balances the client already has
(it does **not** read the user's account — keeps it app-key-only and
non-sensitive; see Auth):

```ts
const WalletValueBody = Type.Object({
  balances: Type.Object({
    btcSats: Type.Optional(Type.Integer({ minimum: 0 })),
    archLamports: Type.Optional(Type.String()),               // u64 as string
    apl: Type.Optional(Type.Array(Type.Object({
      mint: Type.String(), rawAmount: Type.String(), decimals: Type.Integer(),
    }))),
    runes: Type.Optional(Type.Array(Type.Object({
      runeId: Type.String(), rawAmount: Type.String(), divisibility: Type.Integer(),
    }))),
  }),
  vs: Type.Optional(Type.Literal("usd")),
});
```

Response mirrors the existing client `PortfolioValuation`: `totalUsd`,
per-class subtotals, `change24hPct`, and a `breakdown` map flagging
`unpriced: true` entries plus an `asOf`/`stale` for the snapshot.

> Decision for the team: do we even want server-side wallet-value math,
> or is `GET /v1/prices` + client-side multiply enough? See Open
> questions. v1 can ship prices-only and keep `valuatePortfolio`
> client-side, just fed by the Hub instead of CoinGecko.

### Auth

**App API key only** (the existing `x-api-key` / `Bearer` gate in
`plugins/appAuth.ts`). These routes are **read-only, non-user-scoped,
public-market data** — identical to the indexer proxy, which is
deliberately app-key-only with "Public-data reads only -- no per-user
session needed."

Concretely: **do NOT add these route keys to
`SESSION_ENFORCED_ROUTES`.** Session enforcement exists to stop IDOR on
*user-scoped* routes that move funds or read someone's private data (see
`docs/security/session-auth-rollout.md`). A price is the same for every
user; requiring a `whs_v1_` session token would break the Dashboard's
pre-onboarding load (prices render before any wallet/session exists),
exactly the reason the indexer reads stay session-free. `/v1/prices`
should also stay out of the `isPublicPath` allowlist — it still needs a
valid app key for attribution + rate-limiting, just not a session.

Per-install attribution + rate-limit dimension reuses the existing
`x-arch-install-id` header convention from the indexer routes.

## Data sources & strategy

The core insight: **no single upstream covers our assets.** Split by
asset class and let each id resolve through the right resolver.

```
            ┌────────────────────────────────────────────┐
  GET /v1/prices?ids=...                                  │
            │                                             │
   ┌────────┴─────────┐   ┌──────────────────┐   ┌────────┴────────┐
   │ btc / arch       │   │ apl:<mint>       │   │ rune:<rune_id>  │
   │ → external API   │   │ → on-chain AMM   │   │ → AMM if pool;  │
   │   (CoinGecko)    │   │   quote × BTCUSD │   │   else indexer; │
   │                  │   │   (fallback:     │   │   else null     │
   │                  │   │   indexer meta)  │   │                 │
   └──────────────────┘   └──────────────────┘   └─────────────────┘
            │                       │                      │
            └───────────── merge + cache (Postgres + in-mem) ──────────┘
```

### BTC & major tokens → external API (CoinGecko in v1)

Server-side CoinGecko `simple/price` for `bitcoin` and `arch-network`,
keyed by `COINGECKO_API_KEY` (added to `config/env.ts`, injected from
Secrets Manager `WalletHub/AppSecrets`, exactly like `INDEXER_API_KEY`
is wired in `infra/cdk/lib/wallet-hub-stack.ts`). Using a server-side
keyed plan (vs. the clients' anonymous calls) raises the rate limit and
gives us one place to swap providers. `change24hPct` comes from
`include_24hr_change=true`.

ARCH caveat: it may not be listed on CoinGecko yet (the client code
already notes "ARCH may not be on CoinGecko yet"). If unlisted, `arch`
falls through to the AMM resolver — ARCH/BTC pool price × BTC→USD — or
returns `null`. **This is the strongest argument for owning prices
centrally:** the day ARCH lists, we change one mapping, not four
clients.

### APL tokens & runes → on-chain AMM (the part external APIs can't do)

Arch-native tokens trade against BTC on the in-repo AMM. The swap engine
(`packages/arch-swap-engine`) already quotes against a **PropAMM** quote
endpoint (`engine-config.ts → transport.propAmmQuoteUrl`) and parses
base/quote amounts out of the returned runtime tx
(`quote-client.ts`). The price strategy reuses exactly this:

```
priceUsd(token) = (token → BTC implied rate from a small AMM quote) × priceUsd(BTC)
```

i.e. quote a small notional `token → BTC` (or read pool reserves),
divide to get the BTC-denominated unit price, then multiply by the BTC
USD price we already fetched. This gives APL tokens a real USD value
instead of today's universal `unpriced: true`.

- **Source of the AMM price.** Preferred: the Hub reads pool
  reserves / a quote server-side (config: `PROPAMM_QUOTE_URL`, or a
  direct Arch RPC pool read) so the price doesn't depend on a client.
  Reserves-based spot is cheaper and less gameable than a per-request
  quote; a quote is the fallback when reserves aren't directly readable.
- **Runes.** Most runes have no liquid USD market. v1 stance: price a
  rune **only** if (a) it has an AMM pool we can read, or (b) the
  indexer surfaces a price on its rune/token metadata (the wallet
  already opportunistically reads `usd_price` / `price_usd` off indexer
  token detail). Otherwise `price: null`. Don't invent a number.
- **Indexer fallback for APL.** Where the indexer already exposes
  `usd_price` on token detail, use it as a fallback/sanity source. This
  keeps parity with `getTokenPrice()` in `prices.ts`.

### Id → upstream mapping

A small server-side map table, owned here:

- `btc → coingecko:bitcoin`
- `arch → coingecko:arch-network` (with AMM fallback)
- `apl:<mint> → amm pool for <mint>` (fallback `indexer token detail`)
- `rune:<rune_id> → amm pool if any` (fallback `indexer`, else `none`)

Seeded in config/DB so adding a new mapping is data, not a deploy.

### Aggregation / sanity

v1 keeps it simple: first resolver that yields a finite price wins, in
the priority order above. A v2 nice-to-have is cross-checking
AMM-derived BTC prices against the external BTC price and flagging
divergence (cheap manipulation guardrail), but that's explicitly out of
v1.

## Caching & rate-limits

Two layers, because the Hub is multi-instance behind the ALB:

1. **In-process LRU** (per Fargate task) — absorbs the within-task
   burst (a Dashboard refresh asks for ~all ids at once). Tens of
   milliseconds, no DB hit.
2. **Postgres** (`token_prices` table) — shared across tasks and
   survives restarts. The service already provisions Postgres
   (`getDbPool` / migrations); add a migration:

```sql
CREATE TABLE token_prices (
  id         TEXT NOT NULL,      -- "btc", "apl:<mint>", "rune:<rune_id>"
  vs         TEXT NOT NULL,      -- "usd"
  network    TEXT NOT NULL,      -- "mainnet" | "testnet"
  price      NUMERIC,            -- null when unpriceable
  change_24h NUMERIC,
  source     TEXT NOT NULL,
  as_of      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, vs, network)
);
```

**Freshness budgets** (tunable via env, mirroring the clients' current
constants):

- Fresh TTL: ~60s for BTC/ARCH (external), ~30–60s for AMM-derived.
  (Clients use 5 min today; the Hub can refresh faster because it's one
  shared fetch, not N.)
- **Stale-serve budget:** up to ~1h. On upstream failure, serve the last
  good value with `stale: true` rather than `null` — this is exactly the
  `STALE_BUDGET_MS` behavior already in `btc-price.ts`.

**Refresh cadence.** Read-through on request (lazy), with an optional
background refresher for the hot ids (`btc`, `arch`, top APL mints) so
the common case is always a cache hit. v1 can be read-through only;
add the background job in v2 if telemetry shows cold-cache latency.

**Stampede protection.** Single-flight per `(id, vs, network)` — one
in-flight upstream fetch coalesces concurrent callers (the client's
`inflight` promise pattern in `btc-price.ts`, generalized and keyed).
Critical because all clients refresh on the same cadence and would
otherwise thundering-herd the upstream.

**Upstream rate-limit hygiene.** Batch CoinGecko ids into one
`simple/price` call; respect `Retry-After`/429 by extending the stale
window instead of hammering; never echo an upstream 429 to the client as
429 (mirror the indexer proxy's reasoning — surface a soft failure /
stale price so clients don't trigger their own backoff). The whole point
is that the Hub's shared cache means upstream sees ~1 request per TTL,
not one per client per refresh.

## Failure modes

| Scenario | Behavior |
|----------|----------|
| Upstream (CoinGecko) down | Serve last good value with `stale: true` up to the stale budget; past it, `price: null`. |
| AMM unreadable (RPC blip) | `apl:`/`rune:` ids return last good or `null`; BTC/ARCH unaffected. |
| Partial data (some ids price, some don't) | Per-id `price`/`stale`/`source`; response is never all-or-nothing. |
| Asset genuinely unlisted (most runes) | `price: null, source: "none"` — a permanent, expected state, not an error. |
| Testnet | Return `null`/`stale`; don't show misleading fiat (matches current client stance). |

Client contract: **treat `null` as "no price, render —"** and **`stale:
true` as "show it but consider a muted/'as of' indicator."** `asOf` lets
clients show "as of 11:30". Never block UI on this endpoint — it's
display sugar.

HTTP-level: 2xx with per-id nulls is the normal path. Reserve non-2xx
for auth (401 via `appAuth`), bad input (400 from TypeBox), and total
service failure. Errors use the Hub's standard
`{ statusCode, error, message }` envelope.

## Client integration

1. Hub ships `/v1/prices`.
2. Add `getPrices(ids)` to `packages/wallet-hub-sdk` so all clients call
   the Hub the same way (the SDK is already the shared client surface).
3. **Chrome wallet:** replace the CoinGecko fetch in
   `utils/btc-price.ts` and `utils/prices.ts` with the SDK call. Keep
   `valuatePortfolio` client-side initially — just feed it Hub prices
   instead of CoinGecko. APL/rune entries stop being universally
   `unpriced` because the Hub now resolves them via the AMM.
4. **Swap engine:** `engine-config.ts` already takes an injected
   `getBtcUsdPrice`; point it at the SDK/Hub instead of the bundled
   CoinGecko fallback. (Swap *execution* keeps using PropAMM quotes —
   unchanged.)
5. **iOS / Arch Prime:** call `/v1/prices` directly (or
   `/v1/wallet/value` if we ship it) — they never need to know
   CoinGecko exists.

Wallet-value math can live **either** server-side (`/v1/wallet/value`,
good for thin iOS/web clients) **or** client-side (multiply Hub prices
by local balances, what the extension does today). Recommendation: ship
prices-only first; add server-side valuation once a second client
(iOS) actually needs it.

## Rollout & observability

**Phasing**

- **v1 (minimal, shippable):**
  - `GET /v1/prices` (`btc`, `arch`, `apl:<mint>`) — app-key auth,
    Postgres + in-mem cache, single-flight, stale-serve.
  - CoinGecko for BTC/ARCH; AMM (reserves or quote) for APL; indexer
    `usd_price` fallback.
  - SDK `getPrices`; cut the Chrome wallet over; delete the two
    client CoinGecko fetchers.
- **v2 (nice-to-have):**
  - Rune pricing where a pool/listing exists.
  - `POST /v1/wallet/value`.
  - Background hot-id refresher; AMM-vs-external divergence guardrail.
  - Historical/OHLC if a charting need appears.

**Observability** — reuse the `request.completed` structured log
(`plugins/observability.ts`) and add price-specific events:

- `price.cache.hit` / `price.cache.miss` (by source + id class)
- `price.upstream.fetch` with `{ upstream, status, latencyMs }`
- `price.upstream.failure` + `price.served.stale` (so we can alert when
  we've been serving stale > N minutes)
- `price.unpriced` counter by id class (how much of the wallet we
  *can't* value — drives "should we price runes?" decisions)

**OpenAPI** — routes carry TypeBox `schema` + `summary` + `tags:
["prices"]`, so `@fastify/swagger` documents them automatically (same as
every existing route); no separate `openapi.yaml` edit needed. Add a
short section to `docs/architecture.md` once shipped.

## Open questions / decisions for the team

1. **Upstream for BTC/ARCH:** CoinGecko (keyed plan) vs CoinMarketCap vs
   other. Any existing paid plan/key we should reuse? Is **ARCH** listed
   anywhere yet, or is AMM-derived the only real option for it?
2. **Price runes in v1 at all?** Most have no liquid USD market.
   Proposal: `null` unless an AMM pool/indexer price exists. Acceptable
   for the wallet UI?
3. **AMM price source:** read pool **reserves** server-side (cheaper,
   less gameable) vs. call the PropAMM **quote** endpoint per lookup.
   Reserves preferred — is a server-side reserves read available via
   Arch RPC / indexer?
4. **Server-side wallet value (`POST /v1/wallet/value`) in v1, or
   prices-only?** Proposal: prices-only v1; add valuation when iOS needs
   it.
5. **Freshness/stale budgets:** confirm ~60s fresh TTL + ~1h stale-serve
   (vs clients' current 5-min TTL).
6. **Manipulation tolerance:** these prices feed *display* and swap
   *estimates* only. Confirm no one plans to use `/v1/prices` for
   anything settlement-grade (if they do, the design changes — TWAP,
   multi-source median, etc.).

---

## Recommended v1 (summary)

- **Endpoint:** `GET /v1/prices?ids=btc,arch,apl:<mint>&vs=usd`,
  `x-network` header, app-API-key auth (**not** session-enforced).
  Always echoes every id; unpriceable → `price: null`; every point
  carries `asOf` + `stale` + `source`.
- **Data sources:** CoinGecko (server-keyed) for BTC/ARCH; on-chain
  **AMM** (PropAMM reserves/quote × BTC-USD) for arch-native APL tokens —
  the part CoinGecko can't do — with indexer `usd_price` as fallback.
  Runes deferred to v2.
- **Caching:** in-process LRU + shared Postgres `token_prices`;
  ~60s fresh, ~1h stale-serve; single-flight stampede protection; batch
  + back off on upstream 429.
- **Auth:** existing `appAuth` app key + `x-arch-install-id` for
  rate-limiting; read-only public market data, so deliberately **out of
  `SESSION_ENFORCED_ROUTES`**.
- **Clients:** add `getPrices` to `wallet-hub-sdk`; delete CoinGecko
  fetchers in `apps/chrome-wallet` and `packages/arch-swap-engine`.
- **Failure contract:** `null` = render "—"; `stale` = show muted/"as
  of"; never block UI.
