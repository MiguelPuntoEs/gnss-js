/**
 * OSNMA from Septentrio SBF: GALRawINAV (4023) blocks on E1-B carry the
 * nominal I/NAV page pair with its 40-bit OSNMA field.
 */

import { galInavPageCrcOk } from '../navbits/gal';
import { scanSbfFrames, svidToPrn } from '../sbf/frame';
import {
  OsnmaReceiver,
  type OsnmaReceiverOptions,
  type OsnmaStatus,
} from './receiver';

/** SBF signal number of Galileo E1-BC (mosaic refguide §4.1.10). */
const SIG_E1BC = 17;
const TOW_DNU = 4294967295;
/** GST week = GPS week − 1024. */
const GST_GPS_WEEK_OFFSET = 1024;

/**
 * Feed one SBF block at offset `b` to `rx` when it is an E1-B
 * GALRawINAV page with a valid CRC. Returns true if a page was fed.
 */
export function feedSbfOsnmaBlock(
  data: Uint8Array,
  view: DataView,
  b: number,
  id: number,
  len: number,
  rx: OsnmaReceiver
): boolean {
  if (id !== 4023 || len < 52) return false;
  if ((data[b + 17]! & 0x1f) !== SIG_E1BC) return false;
  const prn = svidToPrn(data[b + 14]!);
  if (!prn || prn[0] !== 'E') return false;
  const towMs = view.getUint32(b + 8, true);
  const wnc = view.getUint16(b + 12, true);
  if (towMs === TOW_DNU || wnc === 65535) return false;
  const page = new Uint8Array(32);
  for (let k = 0; k < 8; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    page[4 * k] = w >>> 24;
    page[4 * k + 1] = (w >>> 16) & 0xff;
    page[4 * k + 2] = (w >>> 8) & 0xff;
    page[4 * k + 3] = w & 0xff;
  }
  if (!galInavPageCrcOk(page)) return false;
  // The block time tags the end of the 2-s page; the page starts 2 s earlier.
  let tow = Math.round(towMs / 1000) - 2;
  let wn = wnc - GST_GPS_WEEK_OFFSET;
  if (tow < 0) {
    tow += 604800;
    wn--;
  }
  rx.pushPage(parseInt(prn.slice(1), 10), wn, tow, page);
  return true;
}

/** Run OSNMA verification over every GALRawINAV E1-B page of an SBF stream. */
export function verifySbfOsnma(
  data: Uint8Array,
  opts?: OsnmaReceiverOptions
): OsnmaStatus {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rx = new OsnmaReceiver(opts);
  scanSbfFrames(data, view, (id, b, len) => {
    feedSbfOsnmaBlock(data, view, b, id, len, rx);
  });
  rx.flush();
  return rx.status();
}
