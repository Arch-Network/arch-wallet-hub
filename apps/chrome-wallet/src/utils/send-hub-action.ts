/**
 * Builds the Send page's Wallet Hub action and the intent its response
 * is verified against from the same form inputs, so the two can't drift.
 */
import type { HubSigningIntent } from "./hub-signing-request-verify";

export type SendHubInput =
  | { asset: "arch"; toAddress: string; lamports: string }
  | {
      asset: "apl";
      toAddress: string;
      mintAddress: string;
      amount: string;
      sourceTokenAccount?: string;
      decimals: number;
    };

export function buildSendHubAction(input: SendHubInput) {
  if (input.asset === "apl") {
    const intent = {
      type: "arch.token_transfer" as const,
      mintAddress: input.mintAddress,
      toAddress: input.toAddress,
      amount: input.amount,
      sourceTokenAccount: input.sourceTokenAccount,
    } satisfies HubSigningIntent;
    return { action: { ...intent, decimals: input.decimals }, intent };
  }
  const intent = {
    type: "arch.transfer" as const,
    toAddress: input.toAddress,
    lamports: input.lamports,
  } satisfies HubSigningIntent;
  return { action: intent, intent };
}
