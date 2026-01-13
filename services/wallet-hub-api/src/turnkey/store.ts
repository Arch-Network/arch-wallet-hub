import type { TurnkeyService } from "./client.js";

// Global Turnkey client instance - set by the turnkey plugin, accessible to all routes.
let turnkeyClient: TurnkeyService | null = null;

export function setTurnkeyClient(client: TurnkeyService) {
  turnkeyClient = client;
}

export function getTurnkeyClient(): TurnkeyService {
  if (!turnkeyClient) {
    throw new Error("Turnkey client not initialized. Ensure registerTurnkey plugin runs before routes.");
  }
  return turnkeyClient;
}
