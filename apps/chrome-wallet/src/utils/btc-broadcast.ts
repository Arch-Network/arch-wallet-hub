import * as bitcoin from "bitcoinjs-lib";

interface BroadcastIndexer {
  broadcastBtc(rawTxHex: string): Promise<string>;
  getBtcTransaction(txid: string): Promise<unknown>;
}

/**
 * Broadcast a signed transaction. If the broadcast call fails, check
 * whether the indexer already has this exact txid before reporting
 * failure: a lost response, or a retry of a transaction that already
 * landed, must read as sent, not as "failed — try again". Nothing new
 * is ever broadcast here; an unknown txid rethrows the original error.
 */
export async function broadcastOrReconcile(indexer: BroadcastIndexer, rawTxHex: string): Promise<string> {
  const txid = bitcoin.Transaction.fromHex(rawTxHex).getId();
  try {
    return await indexer.broadcastBtc(rawTxHex);
  } catch (err) {
    const known = await indexer.getBtcTransaction(txid).then(Boolean, () => false);
    if (known) return txid;
    throw err;
  }
}
