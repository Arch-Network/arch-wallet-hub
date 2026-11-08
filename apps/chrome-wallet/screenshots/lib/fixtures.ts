// Deterministic accounts and indexer responses for the screenshot harness.
// Every address below is a valid Testnet4 encoding of a throwaway public
// key (scalars 1–5); none holds funds or belongs to anyone.

export type FixtureAccountId = "native-email" | "native-passkey" | "xverse" | "unisat" | "watch";

const NATIVE_EMAIL_TAPROOT = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const NATIVE_FIDO_TAPROOT = "tb1pet7ep3czdu9k4wvdlz2fp5p8x2yp7t6ttyqg2c6cmh0lgeuu9lasvfnc28";
const XVERSE_ORDINALS = "tb1pgxxyvcmdncdxs06cudd5yvmwwahaesaj6n3eu7st7x4sw9hrchaq9v87jl";
const XVERSE_PAYMENT = "2N2uFi5LbDQQwTqAVd5veF6qE9hWww2DVzF";
const UNISAT_TAPROOT = "tb1pjvtc2mkj9vmfneuj7w9dsqle70a040ms5tyfswhhz4vjyskznj5qgazr9a";
const WATCH_TAPROOT = "tb1paecncecu260mkwvsr63lw5v4s496v9gfn2en56hv4f0d2w2j97fsvpd9al";

const base = { turnkeyResourceId: "", organizationId: "", createdAt: 0 };

export const FIXTURE_ACCOUNTS: Record<FixtureAccountId, Record<string, unknown>> = {
  "native-email": {
    ...base,
    id: "fixture-native-email",
    label: "Everyday wallet",
    btcAddress: NATIVE_EMAIL_TAPROOT,
    publicKeyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    archAddress: "9CEiuSgdHtub59syFf4Usf5eEJaEN5eQqEjJNeCatrJs",
    kind: "turnkey",
    turnkeyResourceId: "screenshot-resource",
    organizationId: "screenshot-org",
    authMethod: "email",
  },
  "native-passkey": {
    ...base,
    id: "fixture-native-passkey",
    label: "Passkey wallet",
    btcAddress: NATIVE_FIDO_TAPROOT,
    publicKeyHex: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
    archAddress: "EKyhkJAh3gQHWTxrJrQ9ttpA9bTMYEoqYPx8vBz6ckwv",
    kind: "turnkey",
    turnkeyResourceId: "screenshot-resource-2",
    organizationId: "screenshot-org-2",
    authMethod: "passkey",
  },
  xverse: {
    ...base,
    id: "fixture-xverse",
    label: "My Xverse",
    btcAddress: XVERSE_ORDINALS,
    publicKeyHex: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
    archAddress: "HmjSoqPhQsr34LXndfXpMB3XzAkdP8tKt5S8y1gkackQ",
    kind: "external",
    authMethod: "external",
    externalProvider: "xverse",
    linkedWalletId: "fixture-xverse",
    verificationScheme: "bip322",
    addresses: [
      {
        address: XVERSE_PAYMENT,
        publicKeyHex: "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
        purposes: ["payment"],
        network: "testnet4",
        addressType: "p2sh",
        chainVerified: true,
      },
      {
        address: XVERSE_ORDINALS,
        publicKeyHex: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
        purposes: ["ordinals"],
        network: "testnet4",
        addressType: "p2tr",
        chainVerified: true,
      },
    ],
  },
  unisat: {
    ...base,
    id: "fixture-unisat",
    label: "My UniSat",
    btcAddress: UNISAT_TAPROOT,
    publicKeyHex: "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
    archAddress: "GPGiuR9nN1axxfh6Rv6nRxfKi5EBrrGvWMRyWUyXNqNi",
    kind: "external",
    authMethod: "external",
    externalProvider: "unisat",
    linkedWalletId: "fixture-unisat",
    verificationScheme: "bip322",
    addresses: [
      {
        address: UNISAT_TAPROOT,
        publicKeyHex: "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
        purposes: ["payment", "ordinals"],
        network: "testnet4",
        addressType: "p2tr",
        chainVerified: true,
      },
    ],
  },
  watch: {
    ...base,
    id: "fixture-watch",
    label: "Cold storage",
    btcAddress: WATCH_TAPROOT,
    publicKeyHex: "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4",
    archAddress: "4Cbs147dJEke8u1QBPdCkgZLmsCnXZvPpzN2sAbQhBUo",
    kind: "watch",
    authMethod: "watch",
  },
};

interface BtcFixture {
  confirmed: number;
  pending?: number;
  protectedSats?: number;
}

const BTC_BY_ADDRESS: Record<string, BtcFixture> = {
  [NATIVE_EMAIL_TAPROOT]: { confirmed: 250_000 },
  [NATIVE_FIDO_TAPROOT]: { confirmed: 0 },
  [XVERSE_PAYMENT]: { confirmed: 120_000, pending: 15_000 },
  [XVERSE_ORDINALS]: { confirmed: 30_000, protectedSats: 10_000 },
  [UNISAT_TAPROOT]: { confirmed: 64_000 },
  [WATCH_TAPROOT]: { confirmed: 1_500_000 },
};

const LAMPORTS_BY_ARCH: Record<string, number> = {
  "9CEiuSgdHtub59syFf4Usf5eEJaEN5eQqEjJNeCatrJs": 42_000_000_000,
  EKyhkJAh3gQHWTxrJrQ9ttpA9bTMYEoqYPx8vBz6ckwv: 0,
  HmjSoqPhQsr34LXndfXpMB3XzAkdP8tKt5S8y1gkackQ: 5_000_000_000,
  GPGiuR9nN1axxfh6Rv6nRxfKi5EBrrGvWMRyWUyXNqNi: 1_250_000_000,
  "4Cbs147dJEke8u1QBPdCkgZLmsCnXZvPpzN2sAbQhBUo": 0,
};

/** BTC/USD used for every capture; ARCH has no market price, as in production. */
export const FIXTURE_BTC_USD = 60_000;

export interface FixtureMode {
  /** Force the Bitcoin history endpoint to fail, to capture the error state. */
  btcHistory: "ok" | "fail";
}

export interface FixtureResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): FixtureResponse => ({ status: 200, body });

function addressSummary(address: string): FixtureResponse {
  const f = BTC_BY_ADDRESS[address] ?? { confirmed: 0 };
  return ok({
    address,
    chain_stats: { funded_txo_sum: f.confirmed, spent_txo_sum: 0 },
    mempool_stats: { funded_txo_sum: f.pending ?? 0, spent_txo_sum: 0 },
    ...(f.protectedSats
      ? { spendable_value: f.confirmed - f.protectedSats, protected_value: f.protectedSats }
      : {}),
  });
}

function utxos(address: string): FixtureResponse {
  const f = BTC_BY_ADDRESS[address];
  if (!f?.confirmed) return ok([]);
  return ok([{ txid: "11".repeat(32), vout: 0, value: f.confirmed, status: { confirmed: true } }]);
}

/**
 * Route a Hub indexer request (`/v1/indexer/...`) to a response with the
 * shape the extension expects for that exact endpoint. Specific
 * sub-routes are matched before the address summary they share a prefix with.
 */
export function fixtureResponse(pathname: string, mode: FixtureMode): FixtureResponse {
  const btc = pathname.match(/\/btc\/address\/([^/]+)(\/.*)?$/);
  if (btc) {
    const address = decodeURIComponent(btc[1]);
    const sub = btc[2] ?? "";
    if (sub === "/txs") {
      return mode.btcHistory === "fail"
        ? { status: 502, body: { message: "upstream unavailable" } }
        : ok([]);
    }
    if (sub === "/utxo") return utxos(address);
    if (sub === "/runes") return ok({ balances: [] });
    if (sub === "/rune-transactions") return ok({ transactions: [], next_cursor: null });
    if (sub === "/inscriptions") return ok({ inscriptions: [], next_cursor: null });
    if (sub === "") return addressSummary(address);
    return { status: 404, body: { message: "not found" } };
  }

  const arch = pathname.match(/\/arch\/accounts\/([^/]+)(\/.*)?$/);
  if (arch) {
    const archAddress = decodeURIComponent(arch[1]);
    const sub = arch[2] ?? "";
    if (sub === "/tokens") return ok({ tokens: [] });
    if (sub.startsWith("/transactions")) return ok({ transactions: [], total_count: 0, next_cursor: null });
    return ok({
      address: archAddress,
      lamports_balance: LAMPORTS_BY_ARCH[archAddress] ?? 0,
      transaction_count: 0,
    });
  }

  if (pathname.endsWith("/btc/fee-estimates")) return ok({ "1": 2, "3": 5, "6": 8 });
  if (pathname.endsWith("/btc/tip")) return ok({ height: 100_000 });
  return ok({});
}

export function coingeckoResponse(): FixtureResponse {
  return ok({ bitcoin: { usd: FIXTURE_BTC_USD } });
}
