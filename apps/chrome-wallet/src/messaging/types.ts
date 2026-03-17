export type MessageType =
  | "GET_STATE"
  | "CONNECT"
  | "DISCONNECT"
  | "GET_ACCOUNT"
  | "GET_BALANCE"
  | "SEND_TRANSFER"
  | "SEND_TOKEN_TRANSFER"
  | "SIGN_MESSAGE"
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

export interface SignPsbtMessage extends BaseMessage {
  type: "SIGN_PSBT";
  payload: { psbt: string; signInputs: Record<string, number[]> };
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
  | SignPsbtMessage
  | ApproveRequestMessage
  | RejectRequestMessage;

export interface MessageResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PendingRequest {
  id: string;
  type: MessageType;
  origin: string;
  payload?: unknown;
  createdAt: number;
}
