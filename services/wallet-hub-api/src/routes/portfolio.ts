import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getIndexerClient } from "../indexer/store.js";
import { getBtcPlatformClient } from "../btcPlatform/store.js";
import { resolveArchAccountAddress } from "../arch/address.js";

const AddressParams = Type.Object({
  address: Type.String({ minLength: 1 })
});

const PortfolioResponse = Type.Object({
  inputAddress: Type.String(),
  resolvedArchAccountAddress: Type.String(),
  btc: Type.Object({
    address: Type.String(),
    summary: Type.Union([Type.Unknown(), Type.Null()]),
    utxos: Type.Union([Type.Unknown(), Type.Null()])
  }),
  arch: Type.Object({
    accountAddress: Type.String(),
    summary: Type.Union([Type.Unknown(), Type.Null()]),
    transactions: Type.Union([Type.Unknown(), Type.Null()])
  })
});

export const registerPortfolioRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/portfolio/:address",
    {
      schema: {
        summary:
          "Unified portfolio: BTC (Arch API platform BTC endpoints) + ARCH/APL (Arch indexer API)",
        tags: ["portfolio"],
        params: AddressParams,
        response: { 200: PortfolioResponse }
      }
    },
    async (request) => {
      const { address } = request.params as any;
      const resolved = resolveArchAccountAddress(address);

      const indexer = getIndexerClient();
      const btc = getBtcPlatformClient();

      const btcAddress = resolved.kind === "taproot" ? resolved.taprootAddress : address;

      const [archSummary, archTxs, btcSummary, btcUtxos] = await Promise.all([
        indexer
          ? indexer.getAccountSummary(resolved.archAccountAddress).catch(() => null)
          : Promise.resolve(null),
        indexer
          ? indexer.getAccountTransactions(resolved.archAccountAddress).catch(() => null)
          : Promise.resolve(null),
        btc ? btc.getAddressSummary(btcAddress).catch(() => null) : Promise.resolve(null),
        btc
          ? btc.getAddressUtxos(btcAddress, { confirmedOnly: false }).catch(() => null)
          : Promise.resolve(null)
      ]);

      return {
        inputAddress: address,
        resolvedArchAccountAddress: resolved.archAccountAddress,
        btc: {
          address: btcAddress,
          summary: btcSummary,
          utxos: btcUtxos
        },
        arch: {
          accountAddress: resolved.archAccountAddress,
          summary: archSummary,
          transactions: archTxs
        }
      };
    }
  );
};
