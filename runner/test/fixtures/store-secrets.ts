/** Shared by the store-secret tests: two store keys and the sentinel no output may carry. */

export const KEY_HEX = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0";
export const OTHER_KEY_HEX = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
/** A value that must never appear anywhere but the resolver's answer. */
export const SENTINEL = "sk-or-v1-SENTINEL-7f3a9c2e-do-not-leak";
