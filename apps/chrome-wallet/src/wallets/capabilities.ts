/**
 * Who signs for an account and what it can do. This is the code half of
 * docs/wallet-capability-matrix.md: every row there marked "supported"
 * must be `ok` here, and every refusal must carry the reason users see.
 */
import { isExternalAccount, isWatchAccount, type WalletAccount } from "../state/types";

export type SignerKind = "passkey" | "email" | "xverse" | "unisat" | "watch";

export interface SignerInfo {
  kind: SignerKind;
  /** Names the signer in text. */
  label: string;
  /** Shorter form for the header badge, where width is tight. */
  badge: string;
  /** Approval happens in another extension's window. */
  external: boolean;
  canSign: boolean;
  /** Primary action on a review screen. */
  approveLabel: string;
}

export function signerKind(account: WalletAccount): SignerKind {
  if (isWatchAccount(account)) return "watch";
  if (isExternalAccount(account)) return account.externalProvider === "unisat" ? "unisat" : "xverse";
  return account.authMethod === "email" ? "email" : "passkey";
}

const SIGNERS: Record<SignerKind, Omit<SignerInfo, "kind">> = {
  passkey: { label: "Passkey", badge: "Passkey", external: false, canSign: true, approveLabel: "Approve" },
  email: { label: "Email", badge: "Email", external: false, canSign: true, approveLabel: "Approve" },
  xverse: { label: "Xverse", badge: "Xverse", external: true, canSign: true, approveLabel: "Continue in Xverse" },
  unisat: { label: "UniSat", badge: "UniSat", external: true, canSign: true, approveLabel: "Continue in UniSat" },
  watch: { label: "Watch-only", badge: "Watch", external: false, canSign: false, approveLabel: "Watch-only" },
};

export function signerInfo(account: WalletAccount): SignerInfo {
  const kind = signerKind(account);
  return { kind, ...SIGNERS[kind] };
}

/**
 * Operations whose availability differs by signer. BTC, rune, and
 * inscription sends spend from the account's Taproot address only: the
 * transaction builder is P2TR-only, so an Xverse payment (P2SH-P2WPKH)
 * balance is displayed but not spent here.
 */
export type Operation =
  | "send.arch"
  | "send.btc"
  | "send.rune"
  | "send.inscription"
  | "swap"
  | "dapp.connect"
  | "dapp.archTransfer"
  | "dapp.archMessageHash"
  | "dapp.signPsbt";

export type Support = { ok: true } | { ok: false; reason: string };

const OK: Support = { ok: true };
const WATCH_ONLY: Support = {
  ok: false,
  reason: "Watch-only wallet — it can't sign or send. Switch to a signing account.",
};

const LINKED_REFUSALS: Partial<Record<Operation, string>> = {
  "dapp.signPsbt":
    "Raw PSBT signing isn't supported for linked wallets yet. Open the source wallet directly.",
};

export function supports(account: WalletAccount, op: Operation): Support {
  const { kind, external } = signerInfo(account);
  if (kind === "watch") return WATCH_ONLY;
  const reason = external ? LINKED_REFUSALS[op] : undefined;
  return reason ? { ok: false, reason } : OK;
}
