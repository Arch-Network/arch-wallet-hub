/**
 * Approve modal for dapp-initiated requests.
 *
 * Phases hardened in this rewrite:
 *   - 1.5  SIGN_PSBT support (decode, render summary, sign).
 *   - 1.6  SIGN_MESSAGE humanization.
 *   - 1.7  Dapp identity strip + per-origin account picker.
 *   - 2.2  Risk banner + balance-after preview hooks (data plumbed
 *           through `useDashboardData`; visual surfaces are minimal
 *           until icons and copy land).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { computeDisplayHash } from "@arch-network/wallet-hub-sdk";
import { useWallet } from "../../hooks/useWallet";
import { walletStore } from "../../state/wallet-store";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { hasConfirmedMainnet, markMainnetConfirmed } from "../../utils/mainnet-confirm";
import { getClient, getExternalUserId, formatWalletHubError } from "../../utils/sdk";
import { truncateAddress, formatArch } from "../../utils/format";
import {
  fetchArchAccountBalance,
  fetchAssociatedTokenBalance,
  type ArchBalanceSnapshot,
  type TokenBalanceSnapshot,
} from "../../utils/arch-rpc";
import { getIndexer } from "../../utils/indexer";
import { deriveAssociatedTokenAddress } from "../../utils/associated-token";
import DappHeader from "../../components/Approve/DappHeader";
import TransferSummary, { AddressText } from "../../components/Approve/TransferSummary";
import {
  ARCH_DECIMALS,
  formatBaseUnits,
  formatSatsAsBtc,
  formatTokenAmountDisplay,
  type TokenAmountDisplay,
} from "../../utils/amount-display";
import { lookupKnownToken, type KnownTokenMeta } from "../../utils/known-tokens";
import { interpretMessage } from "../../utils/sign-message";
import {
  parsePsbt,
  summarizePsbt,
  formatSats,
  evaluatePsbtGate,
  deterministicPsbtSpendSats,
  type PsbtGate,
  type PsbtSummary,
} from "../../utils/psbt-summary";
import {
  assertPsbtSighashTypesAllowed,
  assertSignedInputsAreNetworkUtxos,
  selectPsbtInputsToSign,
} from "../../utils/psbt-checks";
import { signerForAccount } from "../../signers/Signer";
import { isExternalAccount, isWatchAccount, type NetworkId, type WalletAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";
import { signArchMessageHashWithExternalWallet } from "../../utils/external-arch-message-hash";
import { buildSessionSigner } from "../../utils/hub-session";
import { mintHubSessionWithRecovery } from "../../session/hub-session-recovery";
import {
  ensureSigningSessionForAccount,
  EmailSessionNeededError,
} from "../../session/ensure-signing-session";
import SessionBootstrapper from "../../session/SessionBootstrapper";
import { assessOriginRisk, hostnameFromOrigin } from "../../utils/phishing";
import { resolveName, resolvePrimaryName } from "../../utils/name-service";
import {
  buildExplorerUrl,
  notifyTxBroadcast,
  notifyTxFailed,
} from "../../utils/notifications";
import {
  exceedsCap,
  getRecentSpend,
  recordSpend,
} from "../../utils/spend-tracker";
import { parseU64DecimalString } from "../../utils/u64-amount";
import { resolveOriginSigningAccount } from "../../utils/origin-account";
import {
  hubIntentFee,
  verifyHubSigningRequest,
  type VerifiedHubSigningRequest,
} from "../../utils/hub-signing-request-verify";
import bs58 from "bs58";
import {
  feeChargedTo,
  MIN_WALLET_BALANCE_LAMPORTS,
  TOKEN_ACCOUNT_DEPOSIT_LAMPORTS,
  type ArchFee,
} from "../../utils/arch-fee";
import {
  computeArchTransferGate,
  computeTokenTransferGate,
  computeArchSpendCapGate,
  type ArchBalanceGate,
  type TokenBalanceGate,
  type ArchSpendCapGate,
} from "../../utils/transfer-gates";

interface RequestDetails {
  type: string;
  origin: string;
  payload?: any;
  dappName?: string;
  dappIconUrl?: string;
  autoApproveAllowed?: boolean;
}

const INVALID_AMOUNT_MESSAGE =
  "The requested amount is not a plain decimal integer between 0 and 2^64-1. Refusing to sign.";
const ARCH_FEE_UNKNOWN_MESSAGE =
  "Couldn't compute the Arch network fee for this request. Refusing to sign.";

/**
 * Defence against display-vs-sign drift: recompute the canonical
 * hash of the server-returned `display` object and refuse to sign
 * if it doesn't match the `displayHash` field the server claims to
 * have stored.
 *
 * Mirrors the verification in `packages/wallet-hub-ui`'s
 * `TransactionPreview` so the chrome-wallet doesn't silently accept
 * tampered responses just because it uses its own approve UI.
 *
 * Pre-displayHash builds may have legacy rows without the field;
 * the server now computes on-the-fly during GET, so a missing field
 * here means *create* response specifically, which is always
 * fresh-row -- treat as an error rather than a soft warning.
 */
async function assertDisplayHashMatches(sr: {
  display: unknown;
  displayHash?: string;
}): Promise<void> {
  if (!sr.displayHash) {
    throw new Error(
      "Hub response missing displayHash. Refusing to sign without display-integrity binding.",
    );
  }
  const computed = await computeDisplayHash(sr.display);
  if (computed !== sr.displayHash) {
    throw new Error(
      `Display tamper detected: hub reported ${sr.displayHash}, local recompute ${computed}. Refusing to sign.`,
    );
  }
}

// Returns the raw `result` object from the Hub so callers can pick the field they need
async function signAndSubmitRequest(
  client: Awaited<ReturnType<typeof getClient>>,
  activeAccount: WalletAccount,
  signingRequestId: string,
  verified: VerifiedHubSigningRequest,
  externalUserId: string,
  network: NetworkId,
): Promise<any> {
  // Reuse the client the caller already prepared with this account's
  // session token. Calling getClient() here again would re-attach the
  // *active* account's cached token (clobbering the selected account's)
  // between create and submit.
  if (isExternalAccount(activeAccount)) {
    const psbtBase64 = verified.psbtBase64;
    if (!psbtBase64) throw new Error("No PSBT available for external wallet signing");
    const adapter = getExternalWalletAdapter(activeAccount.externalProvider);
    const signature64Hex = await adapter.signPsbt({
      address: activeAccount.btcAddress,
      psbtBase64,
      network,
    });
    const submitRes = await client.submitSigningRequest(signingRequestId, {
      externalUserId,
      signature64Hex,
    });
    return (submitRes as any).result ?? submitRes;
  }

  // Both passkey and email wallets sign locally with the
  // session-stamped signer now -- which path bootstrapped the
  // session (WebAuthn vs OTP) is invisible at this layer. The Hub
  // is informed via /submit but never sees signing material.
  const signer = signerForAccount(activeAccount);
  const { signature64Hex } = await signer.signArchPayload({
    signingRequestId,
    payloadHex: verified.payloadHex,
  });
  const submitRes = await client.submitSigningRequest(signingRequestId, {
    externalUserId,
    signature64Hex,
  });
  return (submitRes as any).result ?? submitRes;
}

function extractTxid(result: any, fallbackId: string): string {
  return result?.txid || result?.txidHex || fallbackId;
}

function MessageSummary({ payload, origin }: { payload: any; origin: string }) {
  const messageHex: string = payload?.message ?? "";
  const summary = useMemo(() => interpretMessage(messageHex, origin), [messageHex, origin]);
  const [showHex, setShowHex] = useState(false);

  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <div className="input-label">Action</div>
        <div style={{ fontWeight: 600 }}>Sign Message</div>
      </div>

      {summary.kind === "binary" && (
        <>
          <div className="approve-risk approve-risk-warn" style={{ marginBottom: 8 }}>
            Binary payload — you are blind-signing raw bytes. {summary.reason}.
          </div>
          <div className="input-label">Hex</div>
          <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
            {summary.hex}
          </div>
        </>
      )}

      {summary.kind === "text" && (
        <>
          <div className="input-label">Message</div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, marginBottom: 8 }}>{summary.text}</div>
          <button className="btn-link" onClick={() => setShowHex((v) => !v)} style={{ background: "none", border: "none", padding: 0, color: "var(--text-muted)", fontSize: 11, textDecoration: "underline" }}>
            {showHex ? "Hide hex" : "Show hex"}
          </button>
          {showHex && (
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 10, marginTop: 6, color: "var(--text-muted)" }}>
              {summary.hex}
            </div>
          )}
        </>
      )}

      {summary.kind === "json" && (
        <>
          <div className="input-label">Structured payload</div>
          <pre style={{ background: "var(--bg-secondary)", padding: 8, borderRadius: 6, fontSize: 11, overflowX: "auto" }}>
            {JSON.stringify(summary.json, null, 2)}
          </pre>
        </>
      )}

      {summary.kind === "siwa" && (
        <>
          {summary.domainMismatch && (
            <div className="approve-risk approve-risk-danger" style={{ marginBottom: 8 }}>
              Domain mismatch: this site is hosted at{" "}
              <strong>{summary.domainMismatch.expected}</strong> but the
              sign-in message claims to be from{" "}
              <strong>{summary.domainMismatch.got}</strong>. Refuse this
              signature unless you are certain it is intentional.
            </div>
          )}
          {summary.timingIssue && (
            <div className="approve-risk approve-risk-warn" style={{ marginBottom: 8 }}>
              {summary.timingIssue.reason === "expired"
                ? `This sign-in message expired at ${summary.timingIssue.at}. The site should refresh the challenge before you sign.`
                : `This sign-in message isn't valid until ${summary.timingIssue.at}.`}
            </div>
          )}
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">Sign in to</div>
            <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{summary.siwa.domain}</div>
          </div>
          {summary.siwa.statement && (
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Statement</div>
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13 }}>
                {summary.siwa.statement}
              </div>
            </div>
          )}
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">With wallet</div>
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
              {summary.siwa.address}
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">URI</div>
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
              {summary.siwa.uri}
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
            Chain: {summary.siwa.chainId} · Issued {summary.siwa.issuedAt}
            {summary.siwa.expirationTime ? ` · Expires ${summary.siwa.expirationTime}` : ""}
            {" · Nonce "}
            {summary.siwa.nonce}
          </div>
          <button
            className="btn-link"
            onClick={() => setShowHex((v) => !v)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--text-muted)",
              fontSize: 11,
              textDecoration: "underline",
              marginTop: 8,
            }}
          >
            {showHex ? "Hide raw message" : "Show raw message"}
          </button>
          {showHex && (
            <pre
              style={{
                background: "var(--bg-secondary)",
                padding: 8,
                borderRadius: 6,
                fontSize: 11,
                marginTop: 6,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {summary.text}
            </pre>
          )}
        </>
      )}

      {summary.kind === "structured" && (
        <>
          {summary.domainMismatch && (
            <div className="approve-risk approve-risk-danger" style={{ marginBottom: 8 }}>
              Domain mismatch: this site claims to be <strong>{summary.domainMismatch.expected}</strong> but the message references <strong>{summary.domainMismatch.got}</strong>.
            </div>
          )}
          <div className="input-label">Message</div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13 }}>{summary.text}</div>
          {summary.url && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
              Embedded URL: {summary.url}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Render the approval card for SIGN_ARCH_MESSAGE_HASH.
 *
 * This is always a blind-sign from the wallet's perspective: we hold
 * a 32-byte transaction-message hash with no decoded instructions to
 * preview. The dapp is responsible for showing a human-readable
 * preview in its own UI; the user's job here is to confirm (a) the
 * dapp origin in the header above and (b) that the hash shown here
 * matches what the dapp claims to be signing.
 *
 * Linked external accounts sign via their source wallet's BIP-322
 * `signMessage`, so Approve opens a second confirmation there.
 */
function ArchMessageHashSummary({
  payload,
  account,
}: {
  payload: any;
  account: WalletAccount | null | undefined;
}) {
  const messageHashHex: string = payload?.messageHashHex ?? "";
  const externalLabel =
    account && isExternalAccount(account)
      ? getExternalWalletAdapter(account.externalProvider).label
      : null;
  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <div className="input-label">Action</div>
        <div style={{ fontWeight: 600 }}>Sign Arch transaction</div>
      </div>

      <div className="approve-risk approve-risk-warn" style={{ marginBottom: 8 }}>
        Blind sign — the wallet cannot decode this transaction's effects.
        Verify the hash matches the preview shown by the dapp before approving.
      </div>

      {externalLabel ? (
        <div className="approve-risk approve-risk-warn" style={{ marginBottom: 8 }}>
          Approving will open {externalLabel} to confirm this signature.
        </div>
      ) : null}

      <div>
        <div className="input-label">Transaction message hash</div>
        <div
          className="mono"
          style={{ wordBreak: "break-all", fontSize: 11, lineHeight: 1.4 }}
        >
          {messageHashHex}
        </div>
      </div>
    </div>
  );
}

/**
 * Optional verified `.arch` metadata for a transfer destination.
 * Authorization always uses the canonical address; a supplied name is
 * shown only after local SDK resolution confirms it maps to that address.
 * Otherwise we fall back to a validated primary reverse lookup.
 */
function VerifiedDestinationName({
  address,
  suppliedName,
  network,
}: {
  address: string;
  suppliedName?: string;
  network: NetworkId;
}) {
  const [verifiedName, setVerifiedName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVerifiedName(null);
    if (!address) return;

    void (async () => {
      const trimmed = suppliedName?.trim();
      if (trimmed) {
        const resolved = await resolveName(trimmed, { network });
        if (
          !cancelled &&
          resolved?.source === "arch-name" &&
          resolved.address === address
        ) {
          setVerifiedName(resolved.name ?? trimmed.toLowerCase());
          return;
        }
      }
      const primary = await resolvePrimaryName(address, { network });
      if (!cancelled) setVerifiedName(primary);
    })();

    return () => {
      cancelled = true;
    };
  }, [address, suppliedName, network]);

  if (!verifiedName) return null;
  return (
    <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
      Verified name: {verifiedName}
    </div>
  );
}

function ArchBalanceCard({
  gate,
  requestedLamports,
}: {
  gate: ArchBalanceGate;
  requestedLamports: bigint | null;
}) {
  if (gate.state === "loading") {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="input-label">Pre-flight balance</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Checking on-chain balance...</div>
      </div>
    );
  }
  if (gate.state === "invalid-amount" || gate.state === "fee-unknown") {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="input-label">Pre-flight balance</div>
        <div className="approve-risk approve-risk-danger">
          {gate.state === "invalid-amount" ? INVALID_AMOUNT_MESSAGE : ARCH_FEE_UNKNOWN_MESSAGE}
        </div>
      </div>
    );
  }
  const notices = (
    <>
      {gate.state === "blocked" && (
        <div className="approve-risk approve-risk-danger" style={{ marginTop: 6 }}>
          {archGateBlockedMessage(gate)}
        </div>
      )}
      {gate.state === "ok" && gate.recipientUnverified && (
        <div className="approve-risk approve-risk-warn" style={{ marginTop: 6 }}>
          Couldn&apos;t read the recipient&apos;s balance. If its account is empty, a send under{" "}
          {MIN_WALLET_BALANCE_LAMPORTS.toString()} lamports will fail on chain.
        </div>
      )}
    </>
  );
  if (gate.snapshot.kind === "not_found") {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="input-label">Pre-flight balance</div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          No on-chain balance found for this account yet. If it&apos;s a fresh
          wallet, the transfer may fail until it&apos;s funded.
        </div>
        {notices}
      </div>
    );
  }
  if (gate.snapshot.kind === "error") {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="input-label">Pre-flight balance</div>
        <div className="approve-risk approve-risk-warn">
          Could not check current balance ({gate.snapshot.reason}). Proceed
          with caution.
        </div>
        {notices}
      </div>
    );
  }
  const current = gate.snapshot.lamports;
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="input-label">Pre-flight balance</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 4 }}>
        <span>Current</span>
        <span className="mono">{formatArch(current.toString())}</span>
      </div>
      {requestedLamports !== null && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 2 }}>
          <span>This transfer</span>
          <span className="mono">- {formatArch(requestedLamports.toString())}</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 2 }}>
        <span>Network fee</span>
        <span className="mono">- {archFeeText(gate.feeLamports)}</span>
      </div>
      {gate.depositLamports > 0n && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 2 }}>
          <span>Token account deposit</span>
          <span className="mono">- {archFeeText(gate.depositLamports)}</span>
        </div>
      )}
      {gate.state === "ok" && gate.postLamports !== null && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid var(--border-divider)",
            fontWeight: 600,
          }}
        >
          <span>After</span>
          <span className="mono">{formatArch(gate.postLamports.toString())}</span>
        </div>
      )}
      {notices}
    </div>
  );
}

function archGateBlockedMessage(gate: Extract<ArchBalanceGate, { state: "blocked" }>): string {
  const min = `${MIN_WALLET_BALANCE_LAMPORTS.toString()} lamports`;
  if (gate.reason === "sender-dust") {
    return `This would leave your account with ${gate.dustLamports} lamports; Arch requires 0 or at least ${min}. Refusing to sign.`;
  }
  if (gate.reason === "recipient-dust") {
    return `This would leave the recipient with ${gate.dustLamports} lamports; Arch requires 0 or at least ${min}. Refusing to sign.`;
  }
  const deposit = gate.depositLamports > 0n ? ` + ${archFeeText(gate.depositLamports)} token account deposit` : "";
  return `Insufficient balance: requested ${formatArch(gate.requestedLamports.toString())} + ${archFeeText(gate.feeLamports)} network fee${deposit}, available ${formatArch(gate.availableLamports.toString())}. Refusing to sign.`;
}

function TokenBalanceCard({
  gate,
  requestedAmount,
  meta,
}: {
  gate: TokenBalanceGate;
  requestedAmount: bigint | null;
  meta: KnownTokenMeta | null;
}) {
  if (gate.state === "loading") {
    return <div className="card" style={{ marginTop: 8 }}><div className="input-label">Pre-flight token balance</div><div style={{ fontSize: 12, opacity: 0.7 }}>Checking associated token account...</div></div>;
  }
  if (gate.state === "invalid-amount") {
    return <div className="card" style={{ marginTop: 8 }}><div className="input-label">Pre-flight token balance</div><div className="approve-risk approve-risk-danger">{INVALID_AMOUNT_MESSAGE}</div></div>;
  }
  if (gate.snapshot.kind !== "found") {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="input-label">Pre-flight token balance</div>
        <div className="approve-risk approve-risk-warn">
          {gate.snapshot.kind === "not_found"
            ? "No matching associated token account was found. The transfer may fail."
            : `Could not verify this token balance (${gate.snapshot.reason}). Proceed with caution.`}
        </div>
      </div>
    );
  }
  const fmt = (raw: bigint) => tokenAmountText(formatTokenAmountDisplay(raw, meta));
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="input-label">Pre-flight token balance</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginTop: 4 }}><span>Current</span><span className="mono" style={{ minWidth: 0, wordBreak: "break-all", textAlign: "right" }}>{fmt(gate.snapshot.amount)}</span></div>
      {requestedAmount !== null && <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginTop: 2 }}><span>This transfer</span><span className="mono" style={{ minWidth: 0, wordBreak: "break-all", textAlign: "right" }}>- {fmt(requestedAmount)}</span></div>}
      {gate.state === "ok" && gate.postAmount !== null && <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--border-divider)", fontWeight: 600 }}><span>After</span><span className="mono" style={{ minWidth: 0, wordBreak: "break-all", textAlign: "right" }}>{fmt(gate.postAmount)}</span></div>}
      {gate.state === "blocked" && <div className="approve-risk approve-risk-danger" style={{ marginTop: 6 }}>Insufficient token balance: requested {fmt(gate.requestedAmount)}, available {fmt(gate.availableAmount)}. Refusing to sign.</div>}
    </div>
  );
}

function archFeeText(lamports: bigint): string {
  return `${formatBaseUnits(lamports, ARCH_DECIMALS)} ARCH`;
}

/** Fee row for a Hub-built Arch transfer; the fee is only the user's when they are `account_keys[0]`. */
function archFeeRow(fee: ArchFee | null, archAddress: string | undefined, extraNote?: string): { value: string; note?: string } {
  if (!fee) return { value: "Unknown", note: ARCH_FEE_UNKNOWN_MESSAGE };
  if (fee.feePayer !== archAddress) {
    return { value: "Not charged to you", note: `Paid by ${truncateAddress(fee.feePayer)}.` };
  }
  return {
    value: archFeeText(fee.feeLamports),
    note: ["Paid in ARCH from this account.", extraNote].filter(Boolean).join(" "),
  };
}

function tokenAmountText(display: TokenAmountDisplay): string {
  return display.kind === "scaled" ? `${display.amount} ${display.symbol}` : `${display.amount} raw units`;
}

function btcText(sats: number): string {
  const btc = formatSatsAsBtc(sats);
  return btc === null ? "Invalid amount" : `${btc} BTC`;
}

function PsbtSummaryCard({
  summary,
  decodeError,
}: {
  summary: PsbtSummary | null;
  decodeError: string | null;
}) {
  if (decodeError) {
    return (
      <div className="card">
        <div className="approve-risk approve-risk-danger" style={{ marginBottom: 8 }}>
          Could not decode this PSBT: {decodeError}. We will not let you sign it.
        </div>
      </div>
    );
  }

  if (!summary) {
    return <div className="card"><div className="spinner" style={{ width: 16, height: 16 }} /></div>;
  }

  const isOutflow = summary.netUserSats < 0;
  const netBtc = formatSatsAsBtc(Math.abs(summary.netUserSats));
  const external = summary.outputs.filter((o) => !o.isMine);
  const ownOutputs = summary.outputs.filter((o) => o.isMine);

  return (
    <TransferSummary
      title="Sign Bitcoin transaction (PSBT)"
      amountLabel={isOutflow ? "Leaves your wallet" : "Net change for your wallet"}
      amount={netBtc === null ? null : `${isOutflow || summary.netUserSats === 0 ? "" : "+"}${netBtc}`}
      symbol="BTC"
      amountNote={
        summary.exactFee
          ? "Your inputs minus the outputs that come back to you."
          : "Not verified: some input amounts are missing, so this may be understated."
      }
      recipients={external.map((o) => ({ label: "Sending to", address: o.address, amount: btcText(o.valueSats) }))}
      fee={summary.exactFee ? { value: btcText(summary.feeSats) } : { value: "Unknown", note: "Some inputs have no prevout amount." }}
    >
      {external.length === 0 && (
        <div className="transfer-note">No outputs go to addresses outside this wallet.</div>
      )}

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          Inputs ({summary.inputs.length}) and outputs back to you ({ownOutputs.length})
        </summary>
        <div style={{ marginTop: 6 }}>
          <div className="input-label" style={{ marginBottom: 4 }}>Inputs</div>
          {summary.inputs.map((i, idx) => (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
              <span className="mono">{i.address ? truncateAddress(i.address, 10) : `${i.txid.slice(0, 8)}...:${i.vout}`}</span>
              <span style={{ color: i.isMine ? "var(--text-primary)" : "var(--text-secondary)" }}>
                {i.isMine ? "you" : "not yours"} {btcText(i.valueSats)}
              </span>
            </div>
          ))}
          <div className="input-label" style={{ marginTop: 8, marginBottom: 4 }}>Outputs back to you</div>
          {ownOutputs.map((o, idx) => (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2, color: "var(--text-secondary)" }}>
              <span className="mono">{o.address ? truncateAddress(o.address, 10) : "(non-standard)"}</span>
              <span>{o.isChange ? "change" : "you"} {btcText(o.valueSats)}</span>
            </div>
          ))}
        </div>
      </details>

      {!summary.exactFee && (
        <div className="approve-risk approve-risk-warn" style={{ marginTop: 8 }}>
          Some inputs are missing prevout amounts. Fee is unknown — proceed with caution.
        </div>
      )}
    </TransferSummary>
  );
}

function AccountPicker({
  accounts,
  selectedId,
  network,
  onSelect,
}: {
  accounts: WalletAccount[];
  selectedId: string;
  network: NetworkId;
  onSelect: (id: string) => void;
}) {
  if (accounts.length <= 1) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="input-label">Connect with</div>
      <select
        className="input"
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box" }}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label} ({truncateAddress(reEncodeTaprootAddress(a.btcAddress, network), 8)})
          </option>
        ))}
      </select>
    </div>
  );
}

function ConnectNetworkCard({
  network,
  btcAddress,
  switching,
  confirmingMainnet,
  onRequestSwitch,
  onConfirmMainnet,
  onCancelMainnetConfirm,
}: {
  network: NetworkId;
  btcAddress: string | undefined;
  switching: boolean;
  confirmingMainnet: boolean;
  onRequestSwitch: () => void;
  onConfirmMainnet: () => void;
  onCancelMainnetConfirm: () => void;
}) {
  const networkLabel = network === "testnet4" ? "Testnet" : "Mainnet";
  const otherLabel = network === "testnet4" ? "Mainnet" : "Testnet";
  const previewAddress = btcAddress
    ? reEncodeTaprootAddress(btcAddress, network)
    : "";

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div className="input-label">Network</div>
          <div style={{ fontWeight: 600 }}>{networkLabel}</div>
        </div>
        {!confirmingMainnet && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRequestSwitch}
            disabled={switching}
          >
            {switching ? "Switching…" : `Switch to ${otherLabel}`}
          </button>
        )}
      </div>
      {previewAddress && (
        <div style={{ marginTop: 10 }}>
          <div className="input-label">Address this site will see</div>
          <div className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
            {previewAddress}
          </div>
        </div>
      )}
      <p style={{ marginTop: 10, marginBottom: 0, fontSize: 12, color: "var(--text-muted)" }}>
        If this site expects a different network, switch before approving.
      </p>
      {confirmingMainnet && (
        <div
          role="alertdialog"
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 8,
            border: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--danger)", marginBottom: 6 }}>
            Switch to Mainnet?
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-secondary)" }}>
            Mainnet uses real funds. Make sure you intend to use real Bitcoin and ARCH.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              style={{ flex: 1 }}
              onClick={onCancelMainnetConfirm}
              disabled={switching}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              style={{ flex: 1 }}
              onClick={onConfirmMainnet}
              disabled={switching}
            >
              {switching ? "Switching…" : "Switch"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Approve() {
  const { requestId } = useParams<{ requestId: string }>();
  const { state, activeAccount, setNetwork, loading: walletLoading } = useWallet();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [isReturning, setIsReturning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [switchingNetwork, setSwitchingNetwork] = useState(false);
  const [confirmingMainnet, setConfirmingMainnet] = useState(false);
  const [psbtLargeOutflowAck, setPsbtLargeOutflowAck] = useState(false);
  const [archBalance, setArchBalance] = useState<ArchBalanceSnapshot | null>(null);
  const [tokenBalance, setTokenBalance] = useState<TokenBalanceSnapshot | null>(null);
  const [recipientArchBalance, setRecipientArchBalance] = useState<ArchBalanceSnapshot | null>(null);
  const [destTokenAccount, setDestTokenAccount] = useState<TokenBalanceSnapshot | null>(null);
  // When an email-wallet user clicks Approve without a live Turnkey
  // session, `ensureSigningSessionForAccount` throws
  // `EmailSessionNeededError`. Previously we surfaced that as a text
  // banner that bounced the user to the dashboard to enter their OTP.
  // Now we mount `SessionBootstrapper` inline so they can complete
  // OTP without leaving the approve flow; on success we re-run the
  // approve handler.
  const [otpAccount, setOtpAccount] = useState<WalletAccount | null>(null);
  const [originRefusal, setOriginRefusal] = useState<string | null>(null);

  const originAccount = useMemo(
    () =>
      request && request.type !== "CONNECT" && !walletLoading && !state.locked
        ? resolveOriginSigningAccount(state, request.origin)
        : null,
    [request, walletLoading, state],
  );

  // SIGN_* / SEND_* sign with the origin's bound account only; CONNECT
  // is where the user picks one.
  const selectedAccount = useMemo(() => {
    if (request && request.type !== "CONNECT") {
      return originAccount?.ok && !originRefusal ? originAccount.account : null;
    }
    return state.accounts.find((a) => a.id === selectedAccountId) ?? activeAccount;
  }, [request, originAccount, originRefusal, state.accounts, selectedAccountId, activeAccount]);

  useEffect(() => {
    if (!requestId || originRefusal || !originAccount || originAccount.ok) return;
    setOriginRefusal(originAccount.reason);
    chrome.runtime.sendMessage({
      type: "REJECT_REQUEST",
      requestId,
      reason: "The account connected to this site is not the wallet's active account",
    });
  }, [requestId, originAccount, originRefusal]);

  // Decode SIGN_PSBT payloads once at the Approve level so the same
  // summary feeds both the body card and the footer gating logic
  // (block / require-confirm). `summarizePsbt` is synchronous so a
  // useMemo is the right primitive; the previous implementation in
  // PsbtSummaryCard used useState+useEffect, which decoded the PSBT
  // twice (once for display, once when we'd need it for gating).
  const psbtDecode = useMemo<{
    summary: PsbtSummary | null;
    error: string | null;
  }>(() => {
    if (request?.type !== "SIGN_PSBT") return { summary: null, error: null };
    const psbtPayload: string = (request.payload as any)?.psbt;
    if (!psbtPayload) return { summary: null, error: "Missing PSBT payload" };
    try {
      return {
        summary: summarizePsbt(
          psbtPayload,
          selectedAccount?.btcAddress ? [reEncodeTaprootAddress(selectedAccount.btcAddress, state.network)] : [],
          state.network === "mainnet" ? "mainnet" : "testnet",
        ),
        error: null,
      };
    } catch (e: any) {
      return { summary: null, error: e?.message || "Could not decode PSBT" };
    }
  }, [request, selectedAccount?.btcAddress, state.network]);

  const psbtGate = useMemo<PsbtGate | null>(
    () => (psbtDecode.summary ? evaluatePsbtGate(psbtDecode.summary) : null),
    [psbtDecode.summary],
  );

  const psbtPolicy = useMemo<
    { ok: true; inputsToSign: number[] } | { ok: false; error: string } | null
  >(() => {
    if (request?.type !== "SIGN_PSBT" || !selectedAccount?.btcAddress) return null;
    try {
      const psbt = parsePsbt((request.payload as any)?.psbt);
      assertPsbtSighashTypesAllowed(psbt);
      return {
        ok: true,
        inputsToSign: selectPsbtInputsToSign(psbt, selectedAccount.btcAddress, (request.payload as any)?.signInputs),
      };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Could not check this PSBT" };
    }
  }, [request, selectedAccount?.btcAddress]);

  const [psbtPrevouts, setPsbtPrevouts] = useState<
    { state: "n/a" } | { state: "loading" } | { state: "ok" } | { state: "blocked"; reason: string }
  >({ state: "n/a" });

  useEffect(() => {
    if (request?.type !== "SIGN_PSBT" || !psbtPolicy?.ok || !selectedAccount?.btcAddress) {
      setPsbtPrevouts({ state: "n/a" });
      return;
    }
    let cancelled = false;
    setPsbtPrevouts({ state: "loading" });
    const address = reEncodeTaprootAddress(selectedAccount.btcAddress, state.network);
    (async () => {
      const utxos = await (await getIndexer()).getBtcAddressUtxos(address);
      assertSignedInputsAreNetworkUtxos(parsePsbt((request.payload as any).psbt), psbtPolicy.inputsToSign, utxos);
    })().then(
      () => {
        if (!cancelled) setPsbtPrevouts({ state: "ok" });
      },
      (e: any) => {
        if (!cancelled) {
          setPsbtPrevouts({ state: "blocked", reason: e?.message || "Could not read this wallet's Bitcoin outputs." });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, psbtPolicy, selectedAccount?.btcAddress, state.network]);

  // Switching account or request type invalidates a stale "I
  // acknowledged the large outflow" tick -- the user is now looking
  // at a different transaction.
  useEffect(() => {
    setPsbtLargeOutflowAck(false);
  }, [requestId, selectedAccountId, psbtDecode.summary?.netUserSats]);

  // Pre-flight Arch balance check for SEND_TRANSFER. Re-fetches
  // whenever the active account changes; cancellation guard avoids
  // a slow first request overwriting a faster second one.
  const requestedArchLamports = useMemo<bigint | null>(() => {
    if (request?.type !== "SEND_TRANSFER") return null;
    return parseU64DecimalString((request.payload as any)?.lamports);
  }, [request]);

  // Token transfers read it too: the fee payer pays the network fee in ARCH.
  useEffect(() => {
    if (request?.type !== "SEND_TRANSFER" && request?.type !== "SEND_TOKEN_TRANSFER") {
      setArchBalance(null);
      return;
    }
    const archAddress = selectedAccount?.archAddress;
    if (!archAddress) {
      setArchBalance({ kind: "error", reason: "Selected account has no Arch address" });
      return;
    }
    let cancelled = false;
    setArchBalance(null);
    (async () => {
      try {
        const indexer = await getIndexer();
        const snap = await fetchArchAccountBalance(indexer, archAddress);
        if (!cancelled) setArchBalance(snap);
      } catch (e: any) {
        if (!cancelled) {
          setArchBalance({ kind: "error", reason: e?.message || "Failed to read balance" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, selectedAccount?.archAddress]);

  // Fee of the message the Hub will build for this request, compiled
  // with the same builders the Hub response is verified against.
  const archFee = useMemo<ArchFee | null>(() => {
    const p = request?.payload as any;
    if (request?.type === "SEND_TRANSFER") {
      return hubIntentFee({ type: "arch.transfer", toAddress: p?.to, lamports: p?.lamports }, selectedAccount?.archAddress);
    }
    if (request?.type === "SEND_TOKEN_TRANSFER") {
      return hubIntentFee(
        { type: "arch.token_transfer", mintAddress: p?.mint, toAddress: p?.to, amount: p?.amount },
        selectedAccount?.archAddress,
      );
    }
    return null;
  }, [request, selectedAccount?.archAddress]);

  // check_rent covers the recipient too: an empty recipient can't end
  // with 1-255 lamports. A self-send has no separate recipient balance.
  const recipientIsOther =
    request?.type === "SEND_TRANSFER" && (request.payload as any)?.to !== selectedAccount?.archAddress;
  useEffect(() => {
    if (!recipientIsOther) {
      setRecipientArchBalance(null);
      return;
    }
    const to = (request?.payload as any)?.to;
    let cancelled = false;
    setRecipientArchBalance(null);
    (async () => {
      try {
        const snap = await fetchArchAccountBalance(await getIndexer(), to);
        if (!cancelled) setRecipientArchBalance(snap);
      } catch (e: any) {
        if (!cancelled) setRecipientArchBalance({ kind: "error", reason: e?.message || "Failed to read balance" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, recipientIsOther]);

  // Whether the recipient's token account exists decides if the Hub's
  // message creates it, which costs the payer TOKEN_ACCOUNT_DEPOSIT_LAMPORTS.
  useEffect(() => {
    if (request?.type !== "SEND_TOKEN_TRANSFER") {
      setDestTokenAccount(null);
      return;
    }
    const { mint, to } = (request.payload ?? {}) as any;
    let cancelled = false;
    setDestTokenAccount(null);
    (async () => {
      try {
        const ownerHex = Array.from(bs58.decode(to), (b) => b.toString(16).padStart(2, "0")).join("");
        const snap = await fetchAssociatedTokenBalance(
          await getIndexer(),
          deriveAssociatedTokenAddress(mint, ownerHex),
          mint,
          ownerHex,
        );
        if (!cancelled) setDestTokenAccount(snap);
      } catch (e: any) {
        if (!cancelled) setDestTokenAccount({ kind: "error", reason: e?.message || "Failed to read token account" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Deposit is waived only when the indexer confirms the account exists.
  const tokenDepositLamports = useMemo<bigint | null>(() => {
    if (request?.type !== "SEND_TOKEN_TRANSFER" || !destTokenAccount) return null;
    return destTokenAccount.kind === "found" ? 0n : TOKEN_ACCOUNT_DEPOSIT_LAMPORTS;
  }, [request, destTokenAccount]);

  // SEND_TRANSFER: amount + fee, sender and recipient rent-checked.
  // SEND_TOKEN_TRANSFER: fee + any token-account deposit.
  const archTransferGate = useMemo<ArchBalanceGate | null>(() => {
    const fee = feeChargedTo(archFee, selectedAccount?.archAddress);
    if (request?.type === "SEND_TRANSFER") {
      return computeArchTransferGate(archBalance, requestedArchLamports, fee, {
        recipient: recipientIsOther ? recipientArchBalance : undefined,
      });
    }
    if (request?.type === "SEND_TOKEN_TRANSFER") {
      if (tokenDepositLamports === null) return { state: "loading" };
      return computeArchTransferGate(archBalance, 0n, fee, { depositLamports: tokenDepositLamports });
    }
    return null;
  }, [request, archBalance, requestedArchLamports, archFee, selectedAccount?.archAddress, recipientIsOther, recipientArchBalance, tokenDepositLamports]);

  const requestedTokenAmount = useMemo<bigint | null>(() => {
    if (request?.type !== "SEND_TOKEN_TRANSFER") return null;
    return parseU64DecimalString((request.payload as any)?.amount);
  }, [request]);

  useEffect(() => {
    if (request?.type !== "SEND_TOKEN_TRANSFER") {
      setTokenBalance(null);
      return;
    }
    const mint = (request.payload as any)?.mint;
    if (!selectedAccount?.publicKeyHex || typeof mint !== "string") {
      setTokenBalance({ kind: "error", reason: "Selected account or token mint is missing" });
      return;
    }
    let cancelled = false;
    setTokenBalance(null);
    (async () => {
      try {
        const tokenAccount = deriveAssociatedTokenAddress(mint, selectedAccount.publicKeyHex);
        const snapshot = await fetchAssociatedTokenBalance(
          await getIndexer(),
          tokenAccount,
          mint,
          selectedAccount.publicKeyHex,
        );
        if (!cancelled) setTokenBalance(snapshot);
      } catch (e: any) {
        if (!cancelled) {
          setTokenBalance({ kind: "error", reason: e?.message || "Failed to derive token account" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, selectedAccount?.publicKeyHex]);

  const tokenTransferGate = useMemo<TokenBalanceGate | null>(() => {
    if (request?.type !== "SEND_TOKEN_TRANSFER") return null;
    return computeTokenTransferGate(tokenBalance, requestedTokenAmount);
  }, [request, tokenBalance, requestedTokenAmount]);

  // Per-origin daily spend cap. State is { state: "loading" | "ok"
  // | "cap-blocked" }; the gate refuses ARCH transfers whose
  // recent24h + pending exceeds the user-configured cap stored in
  // SitePermissions.spendingLimitSatsPerDay (in lamports). Reads
  // are async (chrome.storage.local lookup) so we materialize the
  // result via a useEffect rather than a useMemo.
  const [archSpendCapGate, setArchSpendCapGate] = useState<ArchSpendCapGate>({ state: "n/a" });

  useEffect(() => {
    if (request?.type !== "SEND_TRANSFER" || !request.origin) {
      setArchSpendCapGate({ state: "n/a" });
      return;
    }
    let cancelled = false;
    setArchSpendCapGate({ state: "loading" });
    computeArchSpendCapGate({
      requestedLamports: requestedArchLamports,
      // Cap lives in the site's permissions; absent permissions or
      // an undefined cap mean "no enforcement". We do an explicit
      // lookup rather than relying on a hook because the popup may
      // be opened with no connectedSites entry for this origin yet
      // (first-touch SEND_TRANSFER from a brand-new site).
      readCapLamports: async () =>
        (await walletStore.getSitePermissions(request.origin))?.spendingLimitSatsPerDay,
      readRecentLamports: () =>
        getRecentSpend({
          origin: request.origin,
          asset: "arch",
          network: state.network,
        }),
    }).then((gate) => {
      if (!cancelled) setArchSpendCapGate(gate);
    }).catch(() => {
      // Fail open: a storage-read error shouldn't brick all dapp
      // transfers. The user already opted into the cap; a transient
      // read failure simply skips enforcement for this request.
      if (!cancelled) setArchSpendCapGate({ state: "ok" });
    });
    return () => {
      cancelled = true;
    };
  }, [request, requestedArchLamports, state.network]);

  // BTC is only quota-gated for PSBTs whose exact wallet outflow can be
  // established. Collaborative or partially-described PSBTs remain subject
  // to their normal confirmation safeguards, but cannot be safely charged to
  // a numeric limit.
  const deterministicPsbtSpend = useMemo(
    () => (psbtDecode.summary ? deterministicPsbtSpendSats(psbtDecode.summary) : null),
    [psbtDecode.summary],
  );
  const [btcSpendCapGate, setBtcSpendCapGate] = useState<
    | { state: "n/a" }
    | { state: "loading" }
    | { state: "ok" }
    | { state: "cap-blocked"; capSats: bigint; recentSats: bigint }
  >({ state: "n/a" });

  useEffect(() => {
    if (
      request?.type !== "SIGN_PSBT" ||
      !request.origin ||
      deterministicPsbtSpend === null
    ) {
      setBtcSpendCapGate({ state: "n/a" });
      return;
    }
    let cancelled = false;
    setBtcSpendCapGate({ state: "loading" });
    (async () => {
      const capRaw = (await walletStore.getSitePermissions(request.origin))
        ?.btcSpendingLimitSatsPerDay;
      if (capRaw === undefined || capRaw === null) {
        if (!cancelled) setBtcSpendCapGate({ state: "ok" });
        return;
      }
      const cap = BigInt(capRaw);
      const recent = await getRecentSpend({
        origin: request.origin,
        asset: "btc",
        network: state.network,
      });
      if (cancelled) return;
      if (exceedsCap({ pending: BigInt(deterministicPsbtSpend), recent, cap })) {
        setBtcSpendCapGate({ state: "cap-blocked", capSats: cap, recentSats: recent });
      } else {
        setBtcSpendCapGate({ state: "ok" });
      }
    })().catch(() => {
      if (!cancelled) setBtcSpendCapGate({ state: "ok" });
    });
    return () => {
      cancelled = true;
    };
  }, [request, deterministicPsbtSpend, state.network]);

  useEffect(() => {
    if (!requestId) return;
    chrome.runtime.sendMessage({ type: "GET_PENDING_REQUEST", requestId }, (response) => {
      if (response) {
        setRequest(response);
        if (response.origin) {
          walletStore.isSiteConnected(response.origin).then(setIsReturning).catch(() => setIsReturning(false));
        }
      }
    });
  }, [requestId]);

  useEffect(() => {
    if (activeAccount && !selectedAccountId) {
      setSelectedAccountId(activeAccount.id);
    }
  }, [activeAccount, selectedAccountId]);

  const applyNetworkSwitch = useCallback(
    async (next: NetworkId) => {
      setSwitchingNetwork(true);
      setError(null);
      try {
        await setNetwork(next);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to switch network");
      } finally {
        setSwitchingNetwork(false);
      }
    },
    [setNetwork],
  );

  const handleConnectNetworkSwitch = useCallback(async () => {
    const next: NetworkId = state.network === "mainnet" ? "testnet4" : "mainnet";
    if (next === "mainnet") {
      const confirmed = await hasConfirmedMainnet();
      if (!confirmed) {
        setConfirmingMainnet(true);
        return;
      }
    }
    await applyNetworkSwitch(next);
  }, [state.network, applyNetworkSwitch]);

  const handleConfirmMainnetSwitch = useCallback(async () => {
    setConfirmingMainnet(false);
    await markMainnetConfirmed();
    await applyNetworkSwitch("mainnet");
  }, [applyNetworkSwitch]);

  const sendApproved = useCallback(
    (result: unknown) => {
      chrome.runtime.sendMessage({ type: "APPROVE_REQUEST", requestId, result });
      setSuccess(true);
      setTimeout(() => window.close(), 1500);
    },
    [requestId],
  );

  const signPsbtLocally = useCallback(
    async (psbtHex: string, inputsToSign: number[]): Promise<string> => {
      if (!selectedAccount) throw new Error("No account selected");
      // The session-stamped signer covers both passkey and email
      // wallets transparently -- it uses whichever IndexedDB key was
      // registered at unlock-time. No Hub round-trip for signing.
      const { signedPsbtHex } = await signerForAccount(selectedAccount).signPsbt(
        { psbtHex, inputsToSign },
      );
      return signedPsbtHex;
    },
    [selectedAccount],
  );

  const handleApprove = useCallback(async () => {
    if (!request || !selectedAccount || !requestId) return;
    // Defense in depth: the UI hides the Approve button for watch
    // accounts, but the dapp could conceivably call APPROVE_REQUEST
    // directly. Refuse here too so a UI bug can't produce a confusing
    // session error from deeper in the signing path.
    if (isWatchAccount(selectedAccount)) {
      setError("Watch-only wallet — cannot sign or send transactions.");
      return;
    }
    if (request.type === "SEND_TOKEN_TRANSFER" && tokenTransferGate?.state === "blocked") {
      setError("Insufficient token balance. Refusing to sign.");
      return;
    }
    if (
      (request.type === "SEND_TRANSFER" || request.type === "SEND_TOKEN_TRANSFER") &&
      (archTransferGate?.state === "blocked" || archTransferGate?.state === "fee-unknown")
    ) {
      setError(
        archTransferGate.state === "blocked"
          ? archGateBlockedMessage(archTransferGate)
          : ARCH_FEE_UNKNOWN_MESSAGE,
      );
      return;
    }
    if (
      (request.type === "SEND_TRANSFER" && requestedArchLamports === null) ||
      (request.type === "SEND_TOKEN_TRANSFER" && requestedTokenAmount === null)
    ) {
      setError(INVALID_AMOUNT_MESSAGE);
      return;
    }
    if (request.type === "SIGN_PSBT" && btcSpendCapGate.state === "cap-blocked") {
      setError("Daily Bitcoin spend cap exceeded for this site. Refusing to sign.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Re-open the Turnkey signing session at the point of signing.
      // Otherwise an idle-locked wallet (or a wallet whose session TTL
      // elapsed in the background) bounces the dapp with
      // `SessionLockedError`, which the dapp surfaces as "your wallet
      // is locked" -- when in fact the user just needs to satisfy one
      // WebAuthn prompt. CONNECT skipped: it neither signs nor needs
      // a session, and we don't want to prompt for a passkey on a
      // first-touch site that may end up being rejected.
      if (request.type !== "CONNECT") {
        await ensureSigningSessionForAccount(selectedAccount);
      }

      const client = await getClient();
      const externalUserId = await getExternalUserId();

      // Session enforcement is ON for the Hub money/signing routes
      // (signing-requests.create / .submit). Only these request types
      // reach them; SIGN_PSBT and SIGN_ARCH_MESSAGE_HASH sign locally
      // with no Hub round-trip, so we don't mint (and don't prompt an
      // external wallet) for them.
      const needsHubSession =
        request.type === "SEND_TRANSFER" ||
        request.type === "SEND_TOKEN_TRANSFER" ||
        request.type === "SIGN_MESSAGE";

      // Ensure a valid Hub session token for the EXACT account we're
      // about to sign with (not whichever account happens to be
      // "active" in the store) and attach it to THIS client before the
      // enforced createSigningRequest/submit calls. We await it (no
      // fire-and-forget race) and don't rely on the unlock-time mint,
      // which the signing-session fast path can skip. Also register the
      // signer so the SDK can transparently re-mint if the token
      // expires mid-flight.
      if (needsHubSession) {
        client.setSessionSigner(
          buildSessionSigner(selectedAccount, externalUserId, state.network),
        );
        await mintHubSessionWithRecovery(selectedAccount, state.network);
      }

      if (request.type === "CONNECT") {
        // Hand the dapp the address encoded for the active network. The
        // stored `btcAddress` is a single fixed encoding, so a mainnet
        // wallet would otherwise deliver a testnet-form address (and vice
        // versa) — which network-guarded dapps reject even though the
        // wallet is on the right network. archAddress/publicKey are
        // network-independent. Mirrors the display screens' re-encoding.
        const connectAddress = reEncodeTaprootAddress(
          selectedAccount.btcAddress,
          state.network,
        );
        await chrome.runtime.sendMessage({
          type: "APPROVE_CONNECT",
          requestId,
          origin: request.origin,
          dappName: request.dappName,
          iconUrl: request.dappIconUrl,
          // Internal WalletAccount id (UUID-shaped). The background's
          // APPROVE_CONNECT handler must store this -- not btcAddress --
          // as the site's `accountId`, because `getAccountForOrigin`
          // matches against WalletAccount.id when GET_ACCOUNT runs on a
          // subsequent page load. Storing the btcAddress instead breaks
          // session resume: the dapp's tryResume call returns null, the
          // user is forced through the approval popup on every refresh.
          accountId: selectedAccount.id,
          account: {
            address: connectAddress,
            publicKey: selectedAccount.publicKeyHex,
            archAddress: selectedAccount.archAddress,
            kind: selectedAccount.kind,
          },
        });
        sendApproved({
          address: connectAddress,
          publicKey: selectedAccount.publicKeyHex,
          archAddress: selectedAccount.archAddress,
          kind: selectedAccount.kind,
        });
        return;
      }

      if (request.type === "SEND_TRANSFER" || request.type === "SEND_TOKEN_TRANSFER") {
        const action =
          request.type === "SEND_TRANSFER"
            ? {
                type: "arch.transfer" as const,
                toAddress: request.payload.to,
                lamports: request.payload.lamports,
              }
            : {
                type: "arch.token_transfer" as const,
                mintAddress: request.payload.mint,
                toAddress: request.payload.to,
                amount: request.payload.amount,
              };
        const sr = await client.createSigningRequest({
          externalUserId,
          signer: isExternalAccount(selectedAccount)
            ? {
                kind: "external",
                taprootAddress: selectedAccount.btcAddress,
                publicKeyHex: selectedAccount.publicKeyHex || undefined,
              }
            : { kind: "turnkey", resourceId: selectedAccount.turnkeyResourceId },
          action,
        });
        await assertDisplayHashMatches(sr);
        const verified = verifyHubSigningRequest({
          intent: action,
          account: selectedAccount,
          payloadToSign: sr.payloadToSign,
          display: sr.display,
        });
        if (request.type === "SEND_TOKEN_TRANSFER") {
          // Verified above: the message creates the token account iff
          // display.createDestAta. The idempotent variant is charged the
          // same, since the ATA program source can't confirm it's free.
          const signedGate = computeArchTransferGate(archBalance, 0n, feeChargedTo(archFee, selectedAccount.archAddress), {
            depositLamports: (sr.display as any)?.createDestAta === true ? TOKEN_ACCOUNT_DEPOSIT_LAMPORTS : 0n,
          });
          if (signedGate.state === "blocked") throw new Error(archGateBlockedMessage(signedGate));
          if (signedGate.state === "fee-unknown") throw new Error(ARCH_FEE_UNKNOWN_MESSAGE);
        }
        const submitResult = await signAndSubmitRequest(client, selectedAccount, sr.signingRequestId, verified, externalUserId, state.network);
        const txid = extractTxid(submitResult, sr.signingRequestId);
        sendApproved({ txid });

        // Permission Center: record the spend so the per-origin
        // daily cap is honored on subsequent requests. We do this
        // BEFORE the notification call because failing to record
        // would silently widen the cap on the next request -- the
        // notification is a UI nicety, recording is correctness.
        // SEND_TOKEN_TRANSFER skips this for now: APL amounts are
        // mint-specific (different decimals) and need ATA-level
        // accounting to be comparable to the ARCH cap.
        if (request.type === "SEND_TRANSFER") {
          void recordSpend({
            origin: request.origin,
            asset: "arch",
            network: state.network,
            amount: String(request.payload.lamports),
          });
        }

        // Fire a system notification for dapp-initiated transfers
        // too: the popup closes immediately after `sendApproved`,
        // so without this the user has no in-wallet confirmation
        // that the broadcast went through.
        const notifTitle =
          request.type === "SEND_TOKEN_TRANSFER"
            ? "Token transfer broadcast"
            : "ARCH transfer broadcast";
        const notifMessage =
          request.type === "SEND_TOKEN_TRANSFER"
            ? `Sent via ${hostnameFromOrigin(request.origin) || "dapp"}`
            : `${formatArch(request.payload.lamports)} ARCH sent via ${hostnameFromOrigin(request.origin) || "dapp"}`;
        void notifyTxBroadcast({
          title: notifTitle,
          message: notifMessage,
          explorerUrl: buildExplorerUrl({ kind: "arch", txid, network: state.network }),
        });
        return;
      }

      if (request.type === "SIGN_MESSAGE") {
        const messageHex: string = request.payload?.message;
        if (!messageHex) throw new Error("SIGN_MESSAGE missing payload.message");
        const sr = await client.createSigningRequest({
          externalUserId,
          signer: isExternalAccount(selectedAccount)
            ? {
                kind: "external",
                taprootAddress: selectedAccount.btcAddress,
                publicKeyHex: selectedAccount.publicKeyHex || undefined,
              }
            : { kind: "turnkey", resourceId: selectedAccount.turnkeyResourceId },
          action: { type: "arch.sign_message", messageHex },
        });
        await assertDisplayHashMatches(sr);
        const verified = verifyHubSigningRequest({
          intent: { type: "arch.sign_message", messageHex },
          account: selectedAccount,
          payloadToSign: sr.payloadToSign,
          display: sr.display,
        });
        const submitResult = await signAndSubmitRequest(client, selectedAccount, sr.signingRequestId, verified, externalUserId, state.network);
        const signature = submitResult?.signature64Hex || submitResult?.signature;
        if (!signature) throw new Error("Hub did not return a signature");
        sendApproved({ signature });
        return;
      }

      if (request.type === "SIGN_ARCH_MESSAGE_HASH") {
        const messageHashHex: string = request.payload?.messageHashHex;
        if (!messageHashHex) {
          throw new Error("SIGN_ARCH_MESSAGE_HASH missing payload.messageHashHex");
        }
        // Linked external wallets BIP-322-sign the hex string via their
        // source wallet (same convention as Turnkey's local path), then
        // we unwrap the witness to 64-byte Schnorr for the dapp.
        if (isExternalAccount(selectedAccount)) {
          const { signature64Hex } = await signArchMessageHashWithExternalWallet({
            account: selectedAccount,
            messageHashHex,
            network: state.network,
          });
          sendApproved({ signature64Hex });
          return;
        }
        const signer = signerForAccount(selectedAccount);
        const { signature64Hex } = await signer.signArchMessageHash({
          messageHashHex,
        });
        sendApproved({ signature64Hex });
        return;
      }

      if (request.type === "SIGN_PSBT") {
        const psbtPayload: string = request.payload?.psbt;
        if (!psbtPayload) throw new Error("SIGN_PSBT missing payload.psbt");
        if (isExternalAccount(selectedAccount)) {
          throw new Error("Raw PSBT signing is not supported for linked external wallets yet. Open the source wallet directly.");
        }
        if (!psbtPolicy?.ok) throw new Error(psbtPolicy?.error ?? "This PSBT has not been checked.");
        if (psbtPrevouts.state !== "ok") {
          throw new Error("This PSBT's inputs have not been confirmed on the selected network. Refusing to sign.");
        }

        // Same path for both auth methods now: the session-stamped
        // signer signs locally regardless of how the session was
        // bootstrapped. No more server-side PSBT signing.
        const signedHex = await signPsbtLocally(psbtPayload, psbtPolicy.inputsToSign);
        sendApproved({ psbt: signedHex });
        if (deterministicPsbtSpend !== null) {
          void recordSpend({
            origin: request.origin,
            asset: "btc",
            network: state.network,
            amount: deterministicPsbtSpend,
          });
        }
        return;
      }

      throw new Error(`Unsupported request type: ${request.type}`);
    } catch (e: any) {
      if (e instanceof EmailSessionNeededError) {
        // Don't bounce the user out of the approve flow. Mount the
        // OTP gate inline; `onReady` re-runs this handler.
        setOtpAccount(e.account);
      } else {
        setError(formatWalletHubError(e, "Failed to process request"));
        // Only fire failure notifications for on-chain submission
        // failures. Sign-only requests (SIGN_MESSAGE / SIGN_PSBT /
        // SIGN_ARCH_MESSAGE_HASH) hand bytes back to the dapp; the
        // dapp is the one that surfaces the failure, and a wallet
        // notification on top would be confusing duplication.
        if (request?.type === "SEND_TRANSFER" || request?.type === "SEND_TOKEN_TRANSFER") {
          void notifyTxFailed({
            title:
              request.type === "SEND_TOKEN_TRANSFER"
                ? "Token transfer failed"
                : "ARCH transfer failed",
            message: e?.message ? String(e.message).slice(0, 200) : "Broadcast failed",
          });
        }
      }
    } finally {
      setLoading(false);
    }
  }, [request, selectedAccount, requestId, sendApproved, signPsbtLocally, state.network, deterministicPsbtSpend, tokenTransferGate, archTransferGate, archBalance, archFee, btcSpendCapGate.state, requestedArchLamports, requestedTokenAmount, psbtPolicy, psbtPrevouts.state]);

  const handleOtpReady = useCallback(() => {
    // Session is now open. Drop the bootstrapper and re-attempt the
    // approval; the next `ensureSigningSessionForAccount` call will
    // hit its fast path and proceed to sign + submit.
    setOtpAccount(null);
    setError(null);
    void handleApprove();
  }, [handleApprove]);

  const handleOtpCancel = useCallback(() => {
    // User backed out of OTP. Keep them on the Approve view so they
    // can pick a different account, edit the request, or Reject
    // explicitly. We don't auto-reject -- silently rejecting on a
    // mis-tap would surprise users; the explicit Reject button below
    // already exists.
    setOtpAccount(null);
  }, []);

  const handleReject = useCallback(() => {
    chrome.runtime.sendMessage({ type: "REJECT_REQUEST", requestId });
    window.close();
  }, [requestId]);

  if (success) {
    return (
      <div className="approve-page">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", color: "white" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div style={{ fontWeight: 600 }}>Approved</div>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="approve-page">
        <div className="spinner-center"><div className="spinner" /></div>
      </div>
    );
  }

  // Inline OTP gate: only ever rendered for email wallets that hit
  // `EmailSessionNeededError` during approve. We omit the switch /
  // forget affordances the dashboard variant offers -- the dapp
  // asked to sign with *this* account, and switching wallets mid-
  // approve would change the requested signer in a way the dapp
  // didn't consent to. If the user truly can't complete OTP, they
  // can Cancel (drops back to the approve view) and then Reject.
  if (otpAccount) {
    return (
      <div className="approve-page">
        <SessionBootstrapper
          account={otpAccount}
          onReady={handleOtpReady}
          onCancel={handleOtpCancel}
        />
      </div>
    );
  }

  // Risk banner composition: phishing assessment first (any
  // verdict beats the generic "new site" hint), then the original
  // "new site requesting signature" hint as a softer fallback for
  // first-touch sign requests that don't look phishy.
  const phishingRisk = assessOriginRisk(request.origin);
  // Watch-only takes precedence over the phishing assessment: the
  // user can't sign with this account regardless of who's asking, so
  // surfacing the phishing label on top would be noise.
  const watchOnlyRisk =
    selectedAccount && isWatchAccount(selectedAccount)
      ? {
          level: "warn" as const,
          label: "Watch-only wallet — cannot sign or send transactions. Switch accounts to approve.",
        }
      : undefined;
  const risk =
    watchOnlyRisk ??
    (phishingRisk.reason !== "ok"
      ? { level: phishingRisk.level, label: phishingRisk.label }
      : request.type !== "CONNECT" && !isReturning
        ? { level: "warn" as const, label: "New site requesting a signature. Verify the URL above." }
        : undefined);

  // Only the bundled registry is trusted for decimals and symbol; an
  // unknown mint is shown in raw units rather than guessed.
  const tokenMeta =
    request.type === "SEND_TOKEN_TRANSFER" && request.payload
      ? lookupKnownToken(request.payload.mint, state.network)
      : null;
  const tokenDisplay =
    requestedTokenAmount === null ? null : formatTokenAmountDisplay(requestedTokenAmount, tokenMeta);

  return (
    <div className="approve-page" data-network={state.network}>
      <DappHeader
        origin={request.origin}
        dappName={request.dappName}
        iconUrl={request.dappIconUrl}
        isReturning={isReturning}
        risk={risk}
      />

      <div className="approve-body">
        {error && <div className="error-banner">{error}</div>}

        {originRefusal && (
          <div className="approve-risk approve-risk-danger" style={{ marginBottom: 10 }}>
            {originRefusal} This request was rejected.
          </div>
        )}

        {request.type !== "CONNECT" && originAccount?.account && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="input-label">Signing with</div>
            <div style={{ fontWeight: 600 }}>{originAccount.account.label}</div>
            <div className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
              {reEncodeTaprootAddress(originAccount.account.btcAddress, state.network)}
            </div>
          </div>
        )}

        {request.type === "CONNECT" && (
          <>
            <AccountPicker
              accounts={state.accounts}
              selectedId={selectedAccountId || activeAccount?.id || ""}
              network={state.network}
              onSelect={setSelectedAccountId}
            />
            <ConnectNetworkCard
              network={state.network}
              btcAddress={selectedAccount?.btcAddress}
              switching={switchingNetwork}
              confirmingMainnet={confirmingMainnet}
              onRequestSwitch={handleConnectNetworkSwitch}
              onConfirmMainnet={handleConfirmMainnetSwitch}
              onCancelMainnetConfirm={() => setConfirmingMainnet(false)}
            />
            <div className="card">
              <p style={{ marginBottom: 12 }}>This site wants to connect to your Arch Wallet.</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                It will see your selected address and may request transaction approval.
              </p>
            </div>
          </>
        )}

        {request.type === "SEND_TRANSFER" && request.payload && (
          <>
            <TransferSummary
              title="Send ARCH"
              amountLabel="You send"
              amount={requestedArchLamports === null ? null : formatBaseUnits(requestedArchLamports, ARCH_DECIMALS)}
              symbol="ARCH"
              recipients={[
                {
                  label: "To",
                  address: request.payload.to,
                  detail: (
                    <VerifiedDestinationName
                      address={request.payload.to}
                      suppliedName={request.payload.name}
                      network={state.network}
                    />
                  ),
                },
              ]}
              fee={archFeeRow(archFee, selectedAccount?.archAddress)}
            />
            {archTransferGate && (
              <ArchBalanceCard gate={archTransferGate} requestedLamports={requestedArchLamports} />
            )}
            {archSpendCapGate.state === "cap-blocked" && (
              <div className="approve-risk approve-risk-danger" style={{ marginTop: 8 }}>
                Daily spend cap exceeded for this site.{" "}
                {formatArch(archSpendCapGate.recentLamports.toString())} ARCH already
                used in the last 24h; this request would push you past the{" "}
                {formatArch(archSpendCapGate.capLamports.toString())} ARCH cap. Raise
                or remove the cap in Settings → Connected Sites.
              </div>
            )}
          </>
        )}

        {request.type === "SEND_TOKEN_TRANSFER" && request.payload && (
          <>
            <TransferSummary
              title="Send APL token"
              amountLabel="You send"
              amount={tokenDisplay?.amount ?? null}
              symbol={tokenDisplay?.kind === "scaled" ? tokenDisplay.symbol : undefined}
              amountTag={tokenDisplay?.kind === "raw" ? "raw units" : undefined}
              amountNote={
                tokenDisplay?.kind === "raw"
                  ? "Unknown token: its decimals and symbol aren't known to this wallet, so the amount is shown unscaled."
                  : undefined
              }
              recipients={[
                {
                  label: "To",
                  address: request.payload.to,
                  detail: (
                    <VerifiedDestinationName
                      address={request.payload.to}
                      suppliedName={request.payload.name}
                      network={state.network}
                    />
                  ),
                },
              ]}
              fee={archFeeRow(
                archFee,
                selectedAccount?.archAddress,
                tokenDepositLamports === null
                  ? "The token amount isn't reduced. Checking whether the recipient has a token account…"
                  : tokenDepositLamports > 0n
                    ? `The token amount isn't reduced. Token account deposit: ${archFeeText(tokenDepositLamports)} (the recipient has no token account yet, or it couldn't be confirmed).`
                    : "The token amount isn't reduced. The recipient already has a token account, so no deposit is needed.",
              )}
            >
              <div className="transfer-row">
                <div className="transfer-row-head">
                  <span className="input-label">Token mint</span>
                  <span className="transfer-row-amount">{tokenMeta ? tokenMeta.name : "Unknown token"}</span>
                </div>
                <AddressText address={request.payload.mint} />
              </div>
            </TransferSummary>
            {tokenTransferGate && (
              <TokenBalanceCard gate={tokenTransferGate} requestedAmount={requestedTokenAmount} meta={tokenMeta} />
            )}
            {archTransferGate && <ArchBalanceCard gate={archTransferGate} requestedLamports={null} />}
          </>
        )}

        {request.type === "SIGN_MESSAGE" && request.payload && (
          <MessageSummary payload={request.payload} origin={request.origin} />
        )}

        {request.type === "SIGN_ARCH_MESSAGE_HASH" && request.payload && (
          <ArchMessageHashSummary payload={request.payload} account={selectedAccount} />
        )}

        {request.type === "SIGN_PSBT" && request.payload && (
          <>
            <PsbtSummaryCard summary={psbtDecode.summary} decodeError={psbtDecode.error} />
            {psbtPolicy && !psbtPolicy.ok && (
              <div className="approve-risk approve-risk-danger" style={{ marginTop: 8 }}>
                {psbtPolicy.error} Refusing to sign.
              </div>
            )}
            {psbtPrevouts.state === "loading" && (
              <div className="approve-risk approve-risk-warn" style={{ marginTop: 8 }}>
                Confirming this PSBT&apos;s inputs on the selected network…
              </div>
            )}
            {psbtPrevouts.state === "blocked" && (
              <div className="approve-risk approve-risk-danger" style={{ marginTop: 8 }}>
                {psbtPrevouts.reason} Refusing to sign.
              </div>
            )}
            {psbtGate?.block && (
              <div className="approve-risk approve-risk-danger" style={{ marginTop: 8 }}>
                {psbtGate.block.reason}
              </div>
            )}
            {psbtGate?.requireConfirm && (
              <div className="approve-risk approve-risk-warn" style={{ marginTop: 8 }}>
                <label
                  style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={psbtLargeOutflowAck}
                    onChange={(e) => setPsbtLargeOutflowAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>{psbtGate.requireConfirm.reason}</span>
                </label>
              </div>
            )}
            {deterministicPsbtSpend !== null && btcSpendCapGate.state === "cap-blocked" && (
              <div className="approve-risk approve-risk-danger" style={{ marginTop: 8 }}>
                Daily Bitcoin spend cap exceeded for this site. {formatSats(Number(btcSpendCapGate.recentSats))} already
                authorized in the last 24h; this PSBT would push the total past the{" "}
                {formatSats(Number(btcSpendCapGate.capSats))} cap.
              </div>
            )}
            {deterministicPsbtSpend === null && (
              <div className="approve-risk approve-risk-warn" style={{ marginTop: 8 }}>
                This PSBT has an ambiguous spend amount, so the site&apos;s Bitcoin cap is not applied.
                Review the inputs and outputs before approving.
              </div>
            )}
          </>
        )}
      </div>

      <div className="approve-footer">
        <button
          className="btn btn-secondary"
          onClick={handleReject}
          disabled={loading || switchingNetwork}
        >
          {isWatchAccount(selectedAccount) ? "Close" : "Reject"}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleApprove}
          disabled={
            loading ||
            switchingNetwork ||
            confirmingMainnet ||
            !selectedAccount ||
            !!originRefusal ||
            // Watch-only accounts have no signing key. Disable
            // Approve outright; the in-card "Watch-only wallet" risk
            // banner (rendered above) tells the user why.
            isWatchAccount(selectedAccount) ||
            // Phishing: a `danger` verdict (blocklist hit or close
            // lookalike of a trusted host) hard-blocks Approve. The
            // risk banner above explains why; the user must navigate to
            // the genuine site rather than override here.
            phishingRisk.level === "danger" ||
            // SIGN_PSBT: decode, input policy and prevout confirmation must
            // have succeeded; gate must not be blocking; if a confirm
            // checkbox is required it must be ticked.
            (request.type === "SIGN_PSBT" &&
              (!!psbtDecode.error ||
                !psbtDecode.summary ||
                !psbtPolicy?.ok ||
                psbtPrevouts.state !== "ok" ||
                !!psbtGate?.block ||
                (!!psbtGate?.requireConfirm && !psbtLargeOutflowAck))) ||
            // SEND_TRANSFER / SEND_TOKEN_TRANSFER: refuse when the ARCH
            // balance can't cover amount + network fee, or the fee can't
            // be computed. We do NOT block while the balance is still
            // loading or on indexer error.
            ((request.type === "SEND_TRANSFER" || request.type === "SEND_TOKEN_TRANSFER") &&
              (archTransferGate?.state === "blocked" || archTransferGate?.state === "fee-unknown")) ||
            // SEND_TOKEN_TRANSFER: refuse only on a positively verified
            // insufficient associated-token balance.
            (request.type === "SEND_TOKEN_TRANSFER" && tokenTransferGate?.state === "blocked") ||
            (request.type === "SEND_TRANSFER" &&
              (archTransferGate?.state === "invalid-amount" || archSpendCapGate.state === "invalid-amount")) ||
            (request.type === "SEND_TOKEN_TRANSFER" && tokenTransferGate?.state === "invalid-amount") ||
            // Per-origin daily spend cap (Permission Center). We
            // explicitly do NOT block while the gate is loading; the
            // user can still approve after the lookup resolves.
            (request.type === "SEND_TRANSFER" && archSpendCapGate.state === "cap-blocked") ||
            // BTC is capped only when the PSBT has a deterministic,
            // user-understandable wallet outflow.
            (request.type === "SIGN_PSBT" && btcSpendCapGate.state === "cap-blocked")
          }
        >
          {loading
            ? "Processing..."
            : isWatchAccount(selectedAccount)
              ? "Watch-only"
              : "Approve"}
        </button>
      </div>
    </div>
  );
}
