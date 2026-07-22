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
import { interpretMessage } from "../../utils/sign-message";
import {
  summarizePsbt,
  formatSats,
  evaluatePsbtGate,
  deterministicPsbtSpendSats,
  type PsbtGate,
  type PsbtSummary,
} from "../../utils/psbt-summary";
import { signerForAccount } from "../../signers/Signer";
import { isExternalAccount, isWatchAccount, type NetworkId, type WalletAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";
import { buildSessionSigner } from "../../utils/hub-session";
import { mintHubSessionWithRecovery } from "../../session/hub-session-recovery";
import {
  ensureSigningSessionForAccount,
  EmailSessionNeededError,
} from "../../session/ensure-signing-session";
import SessionBootstrapper from "../../session/SessionBootstrapper";
import { assessOriginRisk, hostnameFromOrigin } from "../../utils/phishing";
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

interface RequestDetails {
  type: string;
  origin: string;
  payload?: any;
  dappName?: string;
  dappIconUrl?: string;
  autoApproveAllowed?: boolean;
}

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
  payloadToSign: any,
  externalUserId: string,
  network: NetworkId,
): Promise<any> {
  // Reuse the client the caller already prepared with this account's
  // session token. Calling getClient() here again would re-attach the
  // *active* account's cached token (clobbering the selected account's)
  // between create and submit.
  if (isExternalAccount(activeAccount)) {
    const psbtBase64 = payloadToSign?.psbtBase64;
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

  const payloadHex = payloadToSign?.payloadHex;
  if (!payloadHex) throw new Error("No payload available for signing");

  // Both passkey and email wallets sign locally with the
  // session-stamped signer now -- which path bootstrapped the
  // session (WebAuthn vs OTP) is invisible at this layer. The Hub
  // is informed via /submit but never sees signing material.
  const signer = signerForAccount(activeAccount);
  const { signature64Hex } = await signer.signArchPayload({
    signingRequestId,
    payloadHex,
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
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, marginBottom: 8 }}>{summary.text}</div>
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
            <div style={{ fontWeight: 600 }}>{summary.siwa.domain}</div>
          </div>
          {summary.siwa.statement && (
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Statement</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
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
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
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
                overflowX: "auto",
                marginTop: 6,
                whiteSpace: "pre-wrap",
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
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{summary.text}</div>
          {summary.url && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
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
 */
function ArchMessageHashSummary({ payload }: { payload: any }) {
  const messageHashHex: string = payload?.messageHashHex ?? "";
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
 * Pre-flight balance check for `arch.transfer` (the SEND_TRANSFER
 * dapp request type).
 *
 * Why static analysis instead of true simulation: the Arch SDK
 * (v0.0.26) exposes no `simulateTransaction` RPC; the available
 * methods (`read_account_info`, `send_transaction`, ...) don't let
 * us dry-run state changes. The closest meaningful pre-flight is
 * to fetch the sender's current lamport balance and predict the
 * post-balance by simple subtraction. Arch transfers don't deduct
 * a lamport fee (anchoring happens via the user's BTC UTXO), so
 * the prediction is exact when the indexer returned a value.
 *
 * SEND_TOKEN_TRANSFER (APL tokens) is intentionally NOT covered
 * here -- token balances live in an associated-token account that
 * needs ATA derivation plus token-account data parsing. Tracked
 * as a follow-up.
 */
type ArchBalanceGate =
  | { state: "loading" }
  | { state: "ok"; snapshot: ArchBalanceSnapshot; postLamports: bigint | null }
  | {
      state: "blocked";
      snapshot: ArchBalanceSnapshot;
      requestedLamports: bigint;
      availableLamports: bigint;
    };

function parseLamportsToBigInt(raw: unknown): bigint | null {
  // Dapps send lamports as either number or string. BigInt parses
  // both; an empty / non-numeric string returns null so we
  // gracefully fail open rather than crashing the modal.
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return BigInt(Math.trunc(raw));
  }
  if (typeof raw === "string") {
    if (!/^-?\d+$/.test(raw.trim())) return null;
    try {
      return BigInt(raw.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function computeArchTransferGate(
  snapshot: ArchBalanceSnapshot | null,
  requestedLamports: bigint | null,
): ArchBalanceGate {
  if (!snapshot) return { state: "loading" };
  if (snapshot.kind !== "found") {
    // not_found / error: surface to the user but don't block.
    // Blocking on a transient indexer outage would brick the
    // wallet for legitimate users.
    return { state: "ok", snapshot, postLamports: null };
  }
  if (requestedLamports === null) {
    // Malformed amount upstream -- the existing render path will
    // also surface this; we don't block here.
    return { state: "ok", snapshot, postLamports: snapshot.lamports };
  }
  if (requestedLamports > snapshot.lamports) {
    return {
      state: "blocked",
      snapshot,
      requestedLamports,
      availableLamports: snapshot.lamports,
    };
  }
  return {
    state: "ok",
    snapshot,
    postLamports: snapshot.lamports - requestedLamports,
  };
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
  if (gate.snapshot.kind === "not_found") {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="input-label">Pre-flight balance</div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          No on-chain balance found for this account yet. If it&apos;s a fresh
          wallet, the transfer may fail until it&apos;s funded.
        </div>
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
      {gate.state === "ok" && gate.postLamports !== null && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 13,
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid var(--border)",
            fontWeight: 600,
          }}
        >
          <span>After</span>
          <span className="mono">{formatArch(gate.postLamports.toString())}</span>
        </div>
      )}
      {gate.state === "blocked" && (
        <div className="approve-risk approve-risk-danger" style={{ marginTop: 6 }}>
          Insufficient balance: requested {formatArch(gate.requestedLamports.toString())}, available{" "}
          {formatArch(gate.availableLamports.toString())}. Refusing to sign.
        </div>
      )}
    </div>
  );
}

type TokenBalanceGate =
  | { state: "loading" }
  | { state: "ok"; snapshot: TokenBalanceSnapshot; postAmount: bigint | null }
  | {
      state: "blocked";
      snapshot: TokenBalanceSnapshot;
      requestedAmount: bigint;
      availableAmount: bigint;
    };

function computeTokenTransferGate(
  snapshot: TokenBalanceSnapshot | null,
  requestedAmount: bigint | null,
): TokenBalanceGate {
  if (!snapshot) return { state: "loading" };
  if (snapshot.kind !== "found") return { state: "ok", snapshot, postAmount: null };
  if (requestedAmount === null || requestedAmount <= 0n) {
    return { state: "ok", snapshot, postAmount: snapshot.amount };
  }
  if (requestedAmount > snapshot.amount) {
    return {
      state: "blocked",
      snapshot,
      requestedAmount,
      availableAmount: snapshot.amount,
    };
  }
  return { state: "ok", snapshot, postAmount: snapshot.amount - requestedAmount };
}

function TokenBalanceCard({
  gate,
  requestedAmount,
}: {
  gate: TokenBalanceGate;
  requestedAmount: bigint | null;
}) {
  if (gate.state === "loading") {
    return <div className="card" style={{ marginTop: 8 }}><div className="input-label">Pre-flight token balance</div><div style={{ fontSize: 12, opacity: 0.7 }}>Checking associated token account...</div></div>;
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
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="input-label">Pre-flight token balance (raw units)</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 4 }}><span>Current</span><span className="mono">{gate.snapshot.amount.toString()}</span></div>
      {requestedAmount !== null && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 2 }}><span>This transfer</span><span className="mono">- {requestedAmount.toString()}</span></div>}
      {gate.state === "ok" && gate.postAmount !== null && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--border)", fontWeight: 600 }}><span>After</span><span className="mono">{gate.postAmount.toString()}</span></div>}
      {gate.state === "blocked" && <div className="approve-risk approve-risk-danger" style={{ marginTop: 6 }}>Insufficient token balance: requested {gate.requestedAmount.toString()}, available {gate.availableAmount.toString()}. Refusing to sign.</div>}
    </div>
  );
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

  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <div className="input-label">Action</div>
        <div style={{ fontWeight: 600 }}>Sign Bitcoin Transaction (PSBT)</div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="input-label">Net change for your wallet</div>
        <div
          style={{
            fontWeight: 700,
            fontSize: 18,
            color: isOutflow ? "var(--danger)" : "var(--success)",
          }}
        >
          {isOutflow ? "" : "+"}{formatSats(summary.netUserSats)}
        </div>
      </div>

      {summary.exactFee && (
        <div style={{ marginBottom: 10 }}>
          <div className="input-label">Network fee</div>
          <div>{formatSats(summary.feeSats)}</div>
        </div>
      )}

      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          Inputs ({summary.inputs.length}) and outputs ({summary.outputs.length})
        </summary>
        <div style={{ marginTop: 6 }}>
          <div className="input-label" style={{ marginBottom: 4 }}>Inputs</div>
          {summary.inputs.map((i, idx) => (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
              <span className="mono">{i.address ? truncateAddress(i.address, 10) : `${i.txid.slice(0, 8)}...:${i.vout}`}</span>
              <span style={{ color: i.isMine ? "var(--text-primary)" : "var(--text-muted)" }}>
                {i.isMine ? "you" : ""} {formatSats(i.valueSats)}
              </span>
            </div>
          ))}
          <div className="input-label" style={{ marginTop: 8, marginBottom: 4 }}>Outputs</div>
          {summary.outputs.map((o, idx) => (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
              <span className="mono">{o.address ? truncateAddress(o.address, 10) : "(non-standard)"}</span>
              <span style={{ color: o.isMine ? "var(--text-primary)" : "var(--text-muted)" }}>
                {o.isChange ? "change" : o.isMine ? "you" : ""} {formatSats(o.valueSats)}
              </span>
            </div>
          ))}
        </div>
      </details>

      {!summary.exactFee && (
        <div className="approve-risk approve-risk-warn" style={{ marginTop: 8 }}>
          Some inputs are missing prevout amounts. Fee is unknown — proceed with caution.
        </div>
      )}
    </div>
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
  const { state, activeAccount, setNetwork } = useWallet();
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
  // When an email-wallet user clicks Approve without a live Turnkey
  // session, `ensureSigningSessionForAccount` throws
  // `EmailSessionNeededError`. Previously we surfaced that as a text
  // banner that bounced the user to the dashboard to enter their OTP.
  // Now we mount `SessionBootstrapper` inline so they can complete
  // OTP without leaving the approve flow; on success we re-run the
  // approve handler.
  const [otpAccount, setOtpAccount] = useState<WalletAccount | null>(null);

  const selectedAccount = useMemo(
    () => state.accounts.find((a) => a.id === selectedAccountId) ?? activeAccount,
    [state.accounts, selectedAccountId, activeAccount],
  );

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
          selectedAccount?.btcAddress ? [selectedAccount.btcAddress] : [],
        ),
        error: null,
      };
    } catch (e: any) {
      return { summary: null, error: e?.message || "Could not decode PSBT" };
    }
  }, [request, selectedAccount?.btcAddress]);

  const psbtGate = useMemo<PsbtGate | null>(
    () => (psbtDecode.summary ? evaluatePsbtGate(psbtDecode.summary) : null),
    [psbtDecode.summary],
  );

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
    return parseLamportsToBigInt((request.payload as any)?.lamports);
  }, [request]);

  useEffect(() => {
    if (request?.type !== "SEND_TRANSFER") {
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

  const archTransferGate = useMemo<ArchBalanceGate | null>(() => {
    if (request?.type !== "SEND_TRANSFER") return null;
    return computeArchTransferGate(archBalance, requestedArchLamports);
  }, [request, archBalance, requestedArchLamports]);

  const requestedTokenAmount = useMemo<bigint | null>(() => {
    if (request?.type !== "SEND_TOKEN_TRANSFER") return null;
    return parseLamportsToBigInt((request.payload as any)?.amount);
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
  const [archSpendCapGate, setArchSpendCapGate] = useState<
    | { state: "n/a" }
    | { state: "loading" }
    | { state: "ok" }
    | { state: "cap-blocked"; capLamports: bigint; recentLamports: bigint }
  >({ state: "n/a" });

  useEffect(() => {
    if (request?.type !== "SEND_TRANSFER") {
      setArchSpendCapGate({ state: "n/a" });
      return;
    }
    if (!request.origin || requestedArchLamports === null) {
      setArchSpendCapGate({ state: "n/a" });
      return;
    }
    let cancelled = false;
    setArchSpendCapGate({ state: "loading" });
    (async () => {
      // Cap lives in the site's permissions; absent permissions or
      // an undefined cap mean "no enforcement". We do an explicit
      // lookup rather than relying on a hook because the popup may
      // be opened with no connectedSites entry for this origin yet
      // (first-touch SEND_TRANSFER from a brand-new site).
      const perms = await walletStore.getSitePermissions(request.origin);
      const capRaw = perms?.spendingLimitSatsPerDay;
      if (capRaw === undefined || capRaw === null) {
        if (!cancelled) setArchSpendCapGate({ state: "ok" });
        return;
      }
      const cap = BigInt(capRaw);
      const recent = await getRecentSpend({
        origin: request.origin,
        asset: "arch",
        network: state.network,
      });
      if (cancelled) return;
      if (exceedsCap({ pending: requestedArchLamports, recent, cap })) {
        setArchSpendCapGate({
          state: "cap-blocked",
          capLamports: cap,
          recentLamports: recent,
        });
      } else {
        setArchSpendCapGate({ state: "ok" });
      }
    })().catch(() => {
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
    async (psbtHex: string): Promise<string> => {
      if (!selectedAccount) throw new Error("No account selected");
      // The session-stamped signer covers both passkey and email
      // wallets transparently -- it uses whichever IndexedDB key was
      // registered at unlock-time. No Hub round-trip for signing.
      const { signedPsbtHex } = await signerForAccount(selectedAccount).signPsbt(
        { psbtHex },
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
          },
        });
        sendApproved({
          address: connectAddress,
          publicKey: selectedAccount.publicKeyHex,
          archAddress: selectedAccount.archAddress,
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
        const submitResult = await signAndSubmitRequest(client, selectedAccount, sr.signingRequestId, sr.payloadToSign, externalUserId, state.network);
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
        const submitResult = await signAndSubmitRequest(client, selectedAccount, sr.signingRequestId, sr.payloadToSign, externalUserId, state.network);
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
        if (isExternalAccount(selectedAccount)) {
          // Linked external wallets (Xverse / UniSat) don't expose a
          // raw-hash signing path -- they'd have to BIP-322-sign the
          // hash as a message string, which would produce a different
          // sighash than the to-sign-taproot wrapper our session
          // signer uses. Refuse cleanly rather than silently produce
          // an invalid signature.
          throw new Error(
            "Raw Arch message-hash signing is not yet supported for linked external wallets. Use a Turnkey account.",
          );
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

        // Same path for both auth methods now: the session-stamped
        // signer signs locally regardless of how the session was
        // bootstrapped. No more server-side PSBT signing.
        const signedHex = await signPsbtLocally(psbtPayload);
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
  }, [request, selectedAccount, requestId, sendApproved, signPsbtLocally, state.network, deterministicPsbtSpend, tokenTransferGate, btcSpendCapGate.state]);

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
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 28 }}>
            ?
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
            <div className="card">
              <div style={{ marginBottom: 8 }}>
                <div className="input-label">Action</div>
                <div style={{ fontWeight: 600 }}>Send ARCH</div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <div className="input-label">To</div>
                <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{request.payload.to}</div>
              </div>
              <div>
                <div className="input-label">Amount</div>
                <div style={{ fontWeight: 600 }}>{formatArch(request.payload.lamports)}</div>
              </div>
            </div>
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
            <div className="card">
              <div style={{ marginBottom: 8 }}>
                <div className="input-label">Action</div>
                <div style={{ fontWeight: 600 }}>Send APL Token</div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <div className="input-label">Token Mint</div>
                <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{request.payload.mint}</div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <div className="input-label">To</div>
                <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{request.payload.to}</div>
              </div>
              <div>
                <div className="input-label">Amount (raw units)</div>
                <div style={{ fontWeight: 600 }}>{request.payload.amount}</div>
              </div>
            </div>
            {tokenTransferGate && (
              <TokenBalanceCard gate={tokenTransferGate} requestedAmount={requestedTokenAmount} />
            )}
          </>
        )}

        {request.type === "SIGN_MESSAGE" && request.payload && (
          <MessageSummary payload={request.payload} origin={request.origin} />
        )}

        {request.type === "SIGN_ARCH_MESSAGE_HASH" && request.payload && (
          <ArchMessageHashSummary payload={request.payload} />
        )}

        {request.type === "SIGN_PSBT" && request.payload && (
          <>
            <PsbtSummaryCard summary={psbtDecode.summary} decodeError={psbtDecode.error} />
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
            // Watch-only accounts have no signing key. Disable
            // Approve outright; the in-card "Watch-only wallet" risk
            // banner (rendered above) tells the user why.
            isWatchAccount(selectedAccount) ||
            // Phishing: a `danger` verdict (blocklist hit or close
            // lookalike of a trusted host) hard-blocks Approve. The
            // risk banner above explains why; the user must navigate to
            // the genuine site rather than override here.
            phishingRisk.level === "danger" ||
            // SIGN_PSBT: decode must have succeeded; gate must not be
            // blocking; if a confirm checkbox is required it must be ticked.
            (request.type === "SIGN_PSBT" &&
              (!!psbtDecode.error ||
                !psbtDecode.summary ||
                !!psbtGate?.block ||
                (!!psbtGate?.requireConfirm && !psbtLargeOutflowAck))) ||
            // SEND_TRANSFER: refuse when the pre-flight balance gate
            // confirmed insufficient funds. We do NOT block while the
            // gate is still loading or on indexer error -- only on a
            // positively-known insufficient balance.
            (request.type === "SEND_TRANSFER" && archTransferGate?.state === "blocked") ||
            // SEND_TOKEN_TRANSFER: refuse only on a positively verified
            // insufficient associated-token balance.
            (request.type === "SEND_TOKEN_TRANSFER" && tokenTransferGate?.state === "blocked") ||
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
