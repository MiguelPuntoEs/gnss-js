/**
 * OSNMA Merkle tree (SIS ICD v1.1 §6.2): the trust anchor that public
 * keys — broadcast in DSM-PKR or loaded from the GSC — are checked
 * against. N = 16 leaves, SHA-256, root x(4,0).
 */

import { sha256 } from './sha256';

const fromHex = (h: string) =>
  new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

/**
 * Root of the OSNMA Merkle tree in force since 2025-12-10 (GSC file
 * OSNMA_MerkleTree_20251209100000_newPKID_2.xml, UID MT-D7A51E17…).
 * Per the ICD a tree is renewed "very rarely, typically after more
 * than 10 years", announced 2 years ahead; pass `merkleRoot` to
 * {@link OsnmaReceiver} to use another one.
 */
export const OSNMA_MERKLE_ROOT = fromHex(
  '832E15EDE55655EAC6E399A539477B7C034CCE24C3C93FFC904ACD9BF842F04E'
);

/** A public key with the Merkle path that proves it against a root. */
export interface OsnmaPublicKeyRecord {
  /** Public key ID (PKID). */
  pkid: number;
  /** Key type (NPKT): 1 = ECDSA P-256, 3 = ECDSA P-521. */
  npkt: number;
  /** SEC1-compressed public key. */
  key: Uint8Array;
  /** Leaf index i of m_i in the tree (MID). */
  mid: number;
  /** Intermediate nodes x(0,·), x(1,·), x(2,·), x(3,·) along the path. */
  path: Uint8Array[];
}

/**
 * The public key in force at the time of writing, PKID 2, as published
 * by the GSC with its Merkle path (leaf m1). It is checked against the
 * root before use, like a broadcast DSM-PKR, so a wrong constant here
 * fails closed.
 */
export const OSNMA_KNOWN_PUBLIC_KEYS: readonly OsnmaPublicKeyRecord[] = [
  {
    pkid: 2,
    npkt: 1,
    key: fromHex(
      '02219204B5CA6C46B623EEED6CDD2CDDB1F7D6A7532767E5B8DA0DE1EBD695FC99'
    ),
    mid: 1,
    path: [
      fromHex(
        '7B944FA20915C7931D48DD016D94F9C6381FD37DC6C125D97015272FDDE41393'
      ),
      fromHex(
        '6AAFDE28017BF0744D42819CE40E3A0CDA1ECA3F7A4EA67E134E7AA714C1E843'
      ),
      fromHex(
        'DE73D209E4C5BCDC34CD117F2FE40FD08B110009997AD2B3291D3A2CF29943F9'
      ),
      fromHex(
        '84DE3669E6DA551292979E5B8D045787FA967C57CC23638A30237614EDD9171A'
      ),
    ],
  },
];

/**
 * Check a Merkle leaf m_i = (NPKT ‖ NPKID ‖ NPK) against `root` through
 * the four intermediate nodes of its path (ICD Eq. 12-13, Table 4).
 */
export function merkleLeafOk(
  leaf: Uint8Array,
  mid: number,
  path: readonly Uint8Array[],
  root: Uint8Array
): boolean {
  if (path.length !== 4 || mid < 0 || mid > 15) return false;
  let x = sha256(leaf);
  let i = mid;
  for (const node of path) {
    x = i & 1 ? sha256(node, x) : sha256(x, node);
    i >>= 1;
  }
  return x.every((b, k) => b === root[k]);
}

/** Leaf bytes of a public key record: (NPKT ‖ NPKID) then the key. */
export function publicKeyLeaf(npkt: number, pkid: number, key: Uint8Array) {
  const leaf = new Uint8Array(1 + key.length);
  leaf[0] = ((npkt & 0xf) << 4) | (pkid & 0xf);
  leaf.set(key, 1);
  return leaf;
}
