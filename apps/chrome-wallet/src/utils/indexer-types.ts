/**
 * Phase 5.4 -- Zod-parsed indexer DTOs.
 *
 * The indexer responses are large and evolve faster than our types
 * can track. Anywhere a page used to do `(response as any).field`,
 * route the response through one of these parsers instead so we get:
 *
 *   - A runtime guarantee the field exists.
 *   - A typed object derived from the schema (no manual interfaces
 *     to drift out of sync).
 *   - A controlled fallback when an upstream API ships a breaking
 *     change.
 *
 * We start with the smallest, highest-leverage DTOs (balance, token
 * list). The rest can adopt this pattern incrementally.
 */

import { z } from "zod";

export const BtcAddressBalance = z.object({
  address: z.string().optional(),
  confirmed: z.number().or(z.string()).optional(),
  unconfirmed: z.number().or(z.string()).optional(),
  total: z.number().or(z.string()).optional(),
});
export type BtcAddressBalance = z.infer<typeof BtcAddressBalance>;

export const ArchAccountToken = z.object({
  mint_address: z.string(),
  amount: z.union([z.string(), z.number()]).default("0"),
  decimals: z.number().default(0),
  ui_amount: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  image: z.string().optional(),
});
export type ArchAccountToken = z.infer<typeof ArchAccountToken>;

export const ArchAccountTokensResponse = z.object({
  tokens: z.array(ArchAccountToken).default([]),
});
export type ArchAccountTokensResponse = z.infer<typeof ArchAccountTokensResponse>;

/**
 * Helper that runs the schema, falls back to a default on failure, and
 * logs the validation issue without blowing up the page.
 */
export function safeParseOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  console.warn("[arch-wallet] schema validation failed", result.error.issues.slice(0, 3));
  return fallback;
}
