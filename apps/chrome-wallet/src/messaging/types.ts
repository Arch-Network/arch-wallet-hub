export type MessageType =
  | "GET_STATE"
  | "PING"
  | "CONNECT"
  | "DISCONNECT"
  | "GET_ACCOUNT"
  | "GET_BALANCE"
  | "SEND_TRANSFER"
  | "SEND_TOKEN_TRANSFER"
  | "SIGN_MESSAGE"
  | "SIGN_ARCH_MESSAGE_HASH"
  | "SIGN_PSBT"
  | "APPROVE_REQUEST"
  | "REJECT_REQUEST"
  | "LOCK"
  | "UNLOCK";

export interface BaseMessage {
  type: MessageType;
  id: string;
  origin?: string;
}

export interface ConnectMessage extends BaseMessage {
  type: "CONNECT";
}

export interface DisconnectMessage extends BaseMessage {
  type: "DISCONNECT";
}

export interface GetAccountMessage extends BaseMessage {
  type: "GET_ACCOUNT";
}

export interface GetBalanceMessage extends BaseMessage {
  type: "GET_BALANCE";
}

export interface SendTransferMessage extends BaseMessage {
  type: "SEND_TRANSFER";
  payload: { to: string; lamports: string };
}

export interface SendTokenTransferMessage extends BaseMessage {
  type: "SEND_TOKEN_TRANSFER";
  payload: { mint: string; to: string; amount: string };
}

export interface SignMessageMessage extends BaseMessage {
  type: "SIGN_MESSAGE";
  payload: { message: string };
}

/**
 * Sign an Arch SanitizedMessage hash locally and return a 64-byte
 * (r||s) Schnorr signature. Unlike SIGN_MESSAGE, this path does NOT
 * round-trip through Wallet Hub: the signer wraps the 32-byte hash
 * in the BIP-322 to-sign taproot sighash for the connected account's
 * btcAddress and Schnorr-signs that digest directly. Designed for
 * dapps that craft their own Arch transactions client-side (custom
 * programs the Hub's canonical action types don't cover).
 *
 * Always gated by the same approval popup as the other signing
 * methods; the dapp can never get a signature without explicit user
 * consent for this exact hash.
 */
export interface SignArchMessageHashMessage extends BaseMessage {
  type: "SIGN_ARCH_MESSAGE_HASH";
  /**
   * 64-char hex of the 32-byte SanitizedMessageUtil.hash output.
   * Validated server-side; non-hex / wrong-length rejects before the
   * popup opens.
   */
  payload: { messageHashHex: string };
}

export interface SignPsbtMessage extends BaseMessage {
  type: "SIGN_PSBT";
  payload: { psbt: string; signInputs?: Record<string, number[]> };
}

export interface ApproveRequestMessage extends BaseMessage {
  type: "APPROVE_REQUEST";
  requestId: string;
}

export interface RejectRequestMessage extends BaseMessage {
  type: "REJECT_REQUEST";
  requestId: string;
}

export type ProviderMessage =
  | ConnectMessage
  | DisconnectMessage
  | GetAccountMessage
  | GetBalanceMessage
  | SendTransferMessage
  | SendTokenTransferMessage
  | SignMessageMessage
  | SignArchMessageHashMessage
  | SignPsbtMessage
  | ApproveRequestMessage
  | RejectRequestMessage;

export interface MessageResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * A queued dapp request awaiting user action in the Approve popup.
 * Persisted to chrome.storage.session so it survives MV3 service-worker
 * restarts.
 */
export interface PendingRequest {
  id: string;
  type: MessageType;
  origin: string;
  payload?: unknown;
  /** Tab title at the time of the request, used to label the dapp. */
  dappName?: string;
  /** Favicon URL of the source tab. */
  dappIconUrl?: string;
  /** Source tab id, used so background can route reject-broadcasts. */
  sourceTabId?: number;
  /** Popup window id created for this request; used by onRemoved auto-reject. */
  windowId?: number;
  /** True when the user has previously granted blanket auto-approval for this method. */
  autoApproveAllowed?: boolean;
  createdAt: number;
}
