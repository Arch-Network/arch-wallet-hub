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
import { getClient, getExternalUserId, formatWalletHubError } from "../../utils/sdk";
import { truncateAddress, formatArch } from "../../utils/format";
import { fetchArchAccountBalance, type ArchBalanceSnapshot } from "../../utils/arch-rpc";
import { getIndexer } from "../../utils/indexer";
import DappHeader from "../../components/Approve/DappHeader";
import { interpretMessage } from "../../utils/sign-message";
import {
  summarizePsbt,
  formatSats,
  evaluatePsbtGate,
  type PsbtGate,
  type PsbtSummary,
} from "../../utils/psbt-summary";
import { signerForAccount } from "../../signers/Signer";
import { isExternalAccount, type NetworkId, type WalletAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";
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
  activeAccount: WalletAccount,
  signingRequestId: string,
  payloadToSign: any,
  externalUserId: string,
  network: NetworkId,
): Promise<any> {
  const client = await getClient();

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

// TODO: enforce `SitePermissions.spendingLimitSatsPerDay` once a
// daily counter lives in the wallet store. Today the field is
// typed (state/types.ts) but unread; surfacing it from here will
// be cleaner once the Permission Center work lands.

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
  onSelect,
}: {
  accounts: WalletAccount[];
  selectedId: string;
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
            {a.label} ({truncateAddress(a.btcAddress, 8)})
          </option>
        ))}
      </select>
    </div>
  );
}

export default function Approve() {
  const { requestId } = useParams<{ requestId: string }>();
  const { state, activeAccount } = useWallet();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [isReturning, setIsReturning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [psbtLargeOutflowAck, setPsbtLargeOutflowAck] = useState(false);
  const [archBalance, setArchBalance] = useState<ArchBalanceSnapshot | null>(null);
  // When an email-wallet user clicks Approve without a live Turnkey
  // session, `ensureSigningSessionForAccount` throws
  // `EmailSessionNeededError`. Previously we surfaced that as a text
  // banner that bounced the user to the dashboard to enter their OTP.
  // Now we mount `SessionBootstrapper` inline so they can complete
  // OTP without leaving the approve flow; on success we re-run the
  // approve handler.
  const [otpAccount, setOtpAccount] = useState<WalletAccount | null>(null);

  const myAddresses = useMemo(
    () => state.accounts.map((a) => a.btcAddress).filter(Boolean),
    [state.accounts],
  );

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
      return { summary: summarizePsbt(psbtPayload, myAddresses), error: null };
    } catch (e: any) {
      return { summary: null, error: e?.message || "Could not decode PSBT" };
    }
  }, [request, myAddresses]);

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

      if (request.type === "CONNECT") {
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
            address: selectedAccount.btcAddress,
            publicKey: selectedAccount.publicKeyHex,
            archAddress: selectedAccount.archAddress,
          },
        });
        sendApproved({
          address: selectedAccount.btcAddress,
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
        const submitResult = await signAndSubmitRequest(selectedAccount, sr.signingRequestId, sr.payloadToSign, externalUserId, state.network);
        const txid = extractTxid(submitResult, sr.signingRequestId);
        sendApproved({ txid });

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
        const submitResult = await signAndSubmitRequest(selectedAccount, sr.signingRequestId, sr.payloadToSign, externalUserId, state.network);
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
  }, [request, selectedAccount, requestId, sendApproved, signPsbtLocally, state.network]);

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
  const risk =
    phishingRisk.reason !== "ok"
      ? { level: phishingRisk.level, label: phishingRisk.label }
      : request.type !== "CONNECT" && !isReturning
        ? { level: "warn" as const, label: "New site requesting a signature. Verify the URL above." }
        : undefined;

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
              onSelect={setSelectedAccountId}
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
          </>
        )}

        {request.type === "SEND_TOKEN_TRANSFER" && request.payload && (
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
              <div className="input-label">Amount</div>
              <div style={{ fontWeight: 600 }}>{request.payload.amount}</div>
            </div>
          </div>
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
          </>
        )}
      </div>

      <div className="approve-footer">
        <button className="btn btn-secondary" onClick={handleReject} disabled={loading}>
          Reject
        </button>
        <button
          className="btn btn-primary"
          onClick={handleApprove}
          disabled={
            loading ||
            !selectedAccount ||
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
            (request.type === "SEND_TRANSFER" && archTransferGate?.state === "blocked")
          }
        >
          {loading ? "Processing..." : "Approve"}
        </button>
      </div>
    </div>
  );
}
