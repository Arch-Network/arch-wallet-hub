/**
 * What a page is told when the bridge in its tab outlived the extension
 * context that injected it. Dapps match on this wording.
 */

/** No working bridge is left in the tab: only a reload brings one back. */
export const BRIDGE_ORPHANED_ERROR =
  "Arch Wallet was updated or turned off. Reload this page to continue.";

/** A request was waiting on an approval when an update replaced the bridge; the new one answers a retry. */
export const BRIDGE_REPLACED_ERROR =
  "Arch Wallet was updated before this request was approved. Try again.";
