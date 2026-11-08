# Wallet capability matrix

What each kind of account can do in Arch Wallet, on which chain, with which
address, and how that has been verified. `src/wallets/capabilities.ts` is the
code half of this document; `src/wallets/__tests__/capabilities.test.ts` holds
the same table and fails if the two drift. Change all three together.

**Verification status.** Every "Supported" cell below is implemented and
covered by unit tests against mocked providers. **None has been exercised
against an installed Xverse or UniSat with testnet funds.** Treat the provider
columns as "should work" until a row is marked live-verified with the provider
version, chain, and date.

## Signers

| | Passkey | Email | Xverse | UniSat | Watch-only |
|---|---|---|---|---|---|
| Unlock on this device | Local password | Local password | Local password | Local password | Local password |
| Approves transactions | In Arch Wallet; a passkey prompt opens a signing session (≤ 1 hour) | In Arch Wallet; an emailed code opens a signing session (≤ 1 hour) | In Xverse's window | In UniSat's window | Can't |
| Arch identity address | Taproot address of the Turnkey wallet | Same | Xverse ordinals Taproot (P2TR) address | UniSat's current address, must be P2TR | Imported address |
| Other addresses stored | — | — | Payment address (P2SH-P2WPKH or P2WPKH) | — (one address serves both purposes) | — |
| Networks | Mainnet and Testnet4 (same key, re-encoded) | Same | One link per network; each network is a separate account | Same | Re-encoded, as before this change |
| Recovery | Recovery email | Email | In Xverse | In UniSat | Re-import |
| Review button | Approve | Approve | Continue in Xverse | Continue in UniSat | Watch-only (disabled) |

## Operations

| Operation | Passkey | Email | Xverse | UniSat | Watch-only |
|---|---|---|---|---|---|
| Send ARCH / APL token | Supported | Supported | Supported | Supported | Refused |
| Send BTC | Supported | Supported | Supported, from the Taproot address only | Supported | Refused |
| Send rune | Supported | Supported | Supported, from the Taproot address only | Supported | Refused |
| Send inscription | Supported | Supported | Supported, from the Taproot address only | Supported | Refused |
| Swap | Supported | Supported | Supported | Supported | Refused |
| Dapp: connect | Supported | Supported | Supported | Supported | Refused |
| Dapp: ARCH / token transfer | Supported | Supported | Supported | Supported | Refused |
| Dapp: sign Arch message hash | Supported | Supported | Supported | Supported | Refused |
| Dapp: sign arbitrary PSBT | Supported | Supported | **Refused** before review | **Refused** before review | Refused |
| Receive | Taproot address | Taproot address | Payment address for BTC, ordinals address for Ordinals/Runes, Arch address | One address for BTC, Ordinals, and Runes; Arch address | Read-only |

The BTC, rune, and inscription builders are P2TR-only, so they spend from the
account's Taproot identity address on the current network. An Xverse payment
balance is shown on the dashboard, labelled per address, but has to be spent in
Xverse. A linked account with no verified address on the current network is
refused rather than given a re-encoded address: a rewritten prefix doesn't prove
control.

From the toolbar popup, a send or swap with a linked wallet reopens in a
standalone window before signing, because the provider's window takes focus
and Chrome closes the toolbar popup. The form's non-secret fields are restored
there. The user reviews again; nothing is approved automatically.

## Providers

### Xverse — sats-connect 4.2.1, legacy callback API

| Concern | Behaviour | Test |
|---|---|---|
| Detection | `XverseProviders.BitcoinProvider` or `BitcoinProvider`, polled in the connector page | "reports a missing provider without calling sats-connect" |
| Addresses | Payment and ordinals requested; stored by purpose and network; identity is the ordinals P2TR address | "returns payment and ordinals separately…" |
| Chain | Requested network passed to Xverse; every address's encoding must match it; `wallet_getNetwork` read within 1.5 s | "refuses when Xverse reports a different network", "refuses addresses encoded for the other network…" |
| Chain unreadable | Link proceeds with `chainVerified: false` recorded on each address | "marks the chain unverified…", "stops waiting on a network read that never resolves" |
| Account change | Exact linked address passed; Xverse refuses to sign for an address outside its current account | Relies on Xverse; **not verified** |
| Message signing | BIP-322 | "signs messages with BIP-322" |
| PSBT signing | `broadcast: false`; inputs named by address; extension finalizes and broadcasts | "signs a BTC send for the exact address and inputs without broadcasting" |
| Rejection | `onCancel` → `USER_REJECTED` | "maps a declined connection to USER_REJECTED" |

The legacy callback API stays because `request("wallet_connect")` never
resolves on some Xverse builds. Keep it until those builds pass regression tests.

### UniSat — `window.unisat`

| Concern | Behaviour | Test |
|---|---|---|
| Detection | `window.unisat`, polled for late injection | "reports a missing provider after waiting for late injection" |
| Address | Must be P2TR; one address for payment and ordinals | "asks for Taproot when the active address is another type" |
| Chain | `getChain()` must report `BITCOIN_MAINNET` or `BITCOIN_TESTNET4`, checked at connect and before every signature | "refuses the wrong chain before asking for accounts", "refuses to sign on the wrong chain" |
| Old builds without `getChain` | Mainnet accepted on `getNetwork() === "livenet"`; Testnet4 refused (can't be told from Testnet3 or Signet) | "can't confirm Testnet4…", "accepts the legacy livenet report for Mainnet" |
| Account change | `getAccounts()[0]` must equal the linked address before every signature | "refuses to sign when UniSat switched to another account" |
| Locked | Empty `getAccounts()` falls back to `requestAccounts()` so UniSat can prompt | "lets a locked UniSat prompt for the account, then signs BIP-322" |
| Message signing | `bip322-simple` | Same |
| PSBT signing | `autoFinalized: false`; BTC sends name each input with `toSignInputs` | "signs only the named inputs for the account address and never finalizes" |
| Rejection | `{ code: 4001 }` → `USER_REJECTED` | "maps a 4001 rejection to USER_REJECTED" |

### Failure states

| Code | What the user sees | Where it comes from | Unit-tested |
|---|---|---|---|
| `PROVIDER_MISSING` | "{Wallet} isn't installed or is turned off…" and, in onboarding, an Install link | Adapter detection | Yes |
| `USER_REJECTED` | "You declined the request in {Wallet}." No failure notification | Adapter | Yes |
| `WRONG_NETWORK` | "{Wallet} is on {network}. Switch {Wallet} to {expected}…" | Adapter chain check | Yes |
| `ACCOUNT_MISMATCH` | "{Wallet} is using a different account. Switch back to {address}…" | UniSat account check, relink | Yes |
| `UNSUPPORTED_ADDRESS` | "Arch needs a Taproot address…" | Adapter | Yes |
| `UNSUPPORTED` | Version-specific refusal | Adapter | Yes |
| `TIMEOUT` | Request expired (connect 120 s, message 180 s, PSBT 240 s) | Content script | No |
| `WINDOW_CLOSED` | "The wallet connection window was closed before the request finished." | Background | No |
| `PROVIDER_ERROR` | "{Wallet}: {provider message}" | Adapter | Yes |

## Arch Wallet as a provider to dapps

| Surface | Exposed | Test |
|---|---|---|
| `window.arch` | Arch methods, unchanged | e2e `wallet-flows.spec.ts` |
| `window.bitcoinArch` | `connect`, `getAccounts`, `signPsbt` (hex or base64, answered in the same encoding), `on`/`removeListener` | `bitcoin-provider.test.ts` |
| `window.bitcoin` | The same object, only when no other script has defined `window.bitcoin` | — |
| Wallet Standard | Registers as "Arch Wallet"; `standard:connect`, `standard:disconnect`, `standard:events` (`change` only), `bitcoin:signPsbt`, Arch features; account `publicKey` is a `Uint8Array` | `bitcoin-provider.test.ts` |
| Not exposed | `sendTransfer` and `signMessage` on the Bitcoin provider, `bitcoin:signMessage` (they ran Arch transfers and Arch message signing under Bitcoin names) | `bitcoin-provider.test.ts` |
| Never touched | `window.unisat`, `XverseProviders`, `BitcoinProvider` | — |
