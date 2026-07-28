/**
 * SBAS L5 (DFMC) message framing — ICAO Annex 10 Vol I, §3.5.10 / Table B-98.
 *
 * A DFMC SBAS message is 250 bits: a 4-bit preamble, a 6-bit message type
 * identifier, a 216-bit data field and a 24-bit CRC-24Q. The CRC information
 * field spans the first 226 bits (preamble + type + data) — the same extent as
 * an L1 (DO-229) message — so {@link ./sbas.sbasCrcOk} validates both formats.
 * The L1 and L5 formats differ only in the preamble width (8 vs 4 bits) and
 * hence the position of the message-type field (bit 8 vs bit 4).
 *
 * This module covers the message *header* only: signal classification (L1 vs
 * L5), the L5 message-type identifier, and the Table B-98 names. The DFMC
 * correction-field decoders (MT31 satellite mask, MT32 clock-ephemeris +
 * covariance, MT34–37 integrity/degradation, MT39/40 SBAS-satellite ephemeris,
 * MT42 SNT-UTC, MT47 almanacs) are intentionally NOT implemented: no accessible
 * SBAS stream currently broadcasts them — EGNOS V3 and WAAS transmit only MT0
 * ("Do Not Use") and MT63 (Null) placeholders on L5 — so field decoders could
 * not be validated against real data. They are a roadmap item, gated on a
 * stream carrying live DFMC corrections. See {@link ./sbas} for the L1 path.
 */
import { getBitU } from './index';

/** DFMC L5 preamble: 24-bit unique word 0x5C693A, distributed 4 bits over six
 *  successive blocks (Annex 10 §3.5.10.2). */
export const SBAS_L5_PREAMBLE_UW = 0x5c693a;
/** The six 4-bit preamble nibbles of {@link SBAS_L5_PREAMBLE_UW}, in order. */
export const SBAS_L5_PREAMBLE_NIBBLES = [0x5, 0xc, 0x6, 0x9, 0x3, 0xa] as const;

/** L1 (DO-229) 8-bit preamble bytes, distributed over three blocks. */
export const SBAS_L1_PREAMBLE_BYTES = [0x53, 0x9a, 0xc6] as const;

/**
 * Classify a CRC-valid GEO message by its preamble. The L5 signal carries a
 * mix: some GEOs relay DO-229 (L1-format) content on L5 — decodable by the
 * existing L1 {@link ../positioning/sbas.SbasProcessor} — while others carry
 * native DFMC frames. The 8-bit L1 preamble is checked first (definitive);
 * anything else is treated as DFMC.
 */
export function isSbasL1Preamble(msg: Uint8Array): boolean {
  return msg[0] === 0x53 || msg[0] === 0x9a || msg[0] === 0xc6;
}

/** L5 (DFMC) message type — 6 bits after the 4-bit preamble (Table B-98). */
export function sbasL5MessageType(msg: Uint8Array): number {
  return getBitU(msg, 4, 6);
}

/** Table B-98 — L5 (DFMC) broadcast message types. */
export const SBAS_L5_MT_NAMES: Readonly<Record<number, string>> = {
  0: 'Do Not Use (test)',
  31: 'SBAS satellite mask',
  32: 'Satellite clock-ephemeris corrections + covariance',
  34: 'Integrity (DFREI/DFRECI)',
  35: 'Integrity (DFREI/DFRECI)',
  36: 'Integrity (DFREI/DFRECI)',
  37: 'Degradation parameters + DFREI scale table',
  39: 'SBAS satellite clock/ephemeris/covariance-1',
  40: 'SBAS satellite clock/ephemeris/covariance-2',
  42: 'SNT-to-UTC offset',
  47: 'SBAS satellite almanacs',
  62: 'Reserved',
  63: 'Null message',
};

/** Human-readable name for an L5 (DFMC) message type. */
export function sbasL5MessageName(type: number): string {
  return (
    SBAS_L5_MT_NAMES[type] ??
    (type >= 1 && type <= 61 ? 'Spare' : `Type ${type}`)
  );
}

/** True for L5 types that carry actual corrections (vs test/null/spare). */
export function isSbasL5Correction(type: number): boolean {
  return (
    type === 31 ||
    type === 32 ||
    (type >= 34 && type <= 37) ||
    type === 39 ||
    type === 40 ||
    type === 42 ||
    type === 47
  );
}
