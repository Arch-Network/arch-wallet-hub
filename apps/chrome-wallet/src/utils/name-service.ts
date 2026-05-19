/**
 * Phase 2.6 — Arch / BTC name service stub.
 *
 * Today this is a passthrough: any input that already looks like an
 * address is returned as-is. The interface is here so the Send flow
 * can pretend names work; when Arch ships a real name service, swap
 * the implementation here and the call sites won't change.
 */

import { detectBtcNetwork } from "./addressNetwork";

export interface NameResolution {
  address: string;
  source: "literal" | "arch-name" | "ens" | "sns";
}

export async function resolveName(input: string): Promise<NameResolution | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already an address? Return as-is.
  if (detectBtcNetwork(trimmed)) return { address: trimmed, source: "literal" };
  // ENS-style name?  e.g. alice.arch / alice.btc / alice.eth
  if (/\.(arch|btc|eth|sats)$/i.test(trimmed)) {
    // Real lookup ships with the name-service integration. Until then
    // we surface a friendly error instead of pretending to resolve.
    return null;
  }
  return { address: trimmed, source: "literal" };
}
