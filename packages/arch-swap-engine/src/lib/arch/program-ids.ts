// Canonical Arch program IDs as raw 32-byte arrays.
//
// Base58-decoded from the on-chain `declare_id!` constants:
//   Token           "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk"
//   Associated Token "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3"

export const TOKEN_PROGRAM_ID = new Uint8Array([
  6, 221, 246, 225, 185, 234, 132, 65, 44, 16, 184, 223, 2, 28, 16, 15,
  200, 135, 25, 7, 195, 9, 195, 53, 53, 222, 32, 156, 52, 23, 99, 191,
]);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new Uint8Array([
  140, 151, 35, 17, 132, 146, 123, 119, 181, 241, 128, 17, 143, 204, 104, 52,
  20, 183, 124, 82, 30, 90, 119, 8, 28, 247, 29, 95, 96, 106, 83, 132,
]);
