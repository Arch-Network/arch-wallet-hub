/**
 * Sign an Arch SanitizedMessage hash with a linked external wallet.
 *
 * Xverse / UniSat BIP-322-simple-sign the hex *string* (same convention as
 * Turnkey's local path). Their response is a witness blob; we unwrap to the
 * 64-byte (r||s) hex Arch dapps expect from `signArchMessageHash`.
 */

import type { WalletAccount } from "../state/types";
import { isExternalAccount, type NetworkId } from "../state/types";
import { getExternalWalletAdapter } from "../wallets/external-wallets";
import { extractSchnorrHexFromWalletSignature } from "./bip322-witness";

export async function signArchMessageHashWithExternalWallet(params: {
  account: WalletAccount;
  messageHashHex: string;
  network: NetworkId;
}): Promise<{ signature64Hex: string }> {
  const { account, messageHashHex, network } = params;
  if (!isExternalAccount(account)) {
    throw new Error("signArchMessageHashWithExternalWallet requires a linked external account");
  }
  if (!/^[0-9a-f]{64}$/i.test(messageHashHex.trim())) {
    throw new Error("messageHashHex must be 64 lowercase hex characters");
  }

  const adapter = getExternalWalletAdapter(account.externalProvider);
  const { signature } = await adapter.signMessage({
    address: account.btcAddress,
    message: messageHashHex.trim().toLowerCase(),
    network,
  });
  return { signature64Hex: extractSchnorrHexFromWalletSignature(signature) };
}
