/**
 * Septentrio receiver health: ReceiverStatus (4014) — CPU load, uptime,
 * temperature, antenna sensing, error words and the per-front-end AGC
 * gain / pulse-blanking table — and RFStatus (4092) — the AIM+ interference
 * report (detected / mitigated bands) and spoofing flags.
 *
 * Layout per the SBF Reference Guide (AsteRx-m3 Pro+ firmware 4.15.1,
 * §4: ReceiverStatus p. 418, RFStatus p. 435). Validated on a real PolaRx5
 * (TU Delft TUDB) ReceiverStatus stream.
 */
import { scanSbfFrames } from './frame';
import type {
  HealthFlag,
  InterferenceReport,
  ReceiverHealthRecord,
  RfBandHealth,
} from '../receiver-health';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

/** ReceiverStatus AGCState FrontendID bits 0–4. */
const FRONTEND: Record<number, string> = {
  0: 'GPS L1/E1',
  1: 'GLO L1',
  2: 'E6',
  3: 'GPS L2',
  4: 'GLO L2',
  5: 'L5/E5a/B2a',
  6: 'E5b/B2b',
  7: 'E5',
  8: 'L1 (GPS/GLO/SBAS/GAL)',
  9: 'L2 (GPS/GLO)',
  10: 'L-band (MSS)',
  11: 'B1',
  12: 'B3',
  13: 'S-band',
  14: 'B3/E6 (combined)',
};

/** RxError bits → flag (Septentrio names). */
const RX_ERROR: [number, HealthFlag][] = [
  [
    3,
    {
      level: 'warning',
      code: 'software',
      text: 'Software warning or error logged — latched until cleared (lif,error)',
    },
  ],
  [4, { level: 'error', code: 'watchdog', text: 'Watchdog reset occurred' }],
  [
    5,
    {
      level: 'error',
      code: 'antenna-short',
      text: 'Antenna overcurrent (short circuit on the antenna feed)',
    },
  ],
  [
    6,
    {
      level: 'warning',
      code: 'congestion',
      text: 'Output congestion — data dropped on an output port',
    },
  ],
  [
    8,
    {
      level: 'warning',
      code: 'missed-event',
      text: 'External event pulses missed',
    },
  ],
  [9, { level: 'warning', code: 'cpu-overload', text: 'CPU overload' }],
  [
    10,
    {
      level: 'warning',
      code: 'invalid-config',
      text: 'Invalid configuration (e.g. a permission/option missing)',
    },
  ],
  [
    11,
    {
      level: 'warning',
      code: 'geofence',
      text: 'Receiver is outside its geofence',
    },
  ],
];

const EXT_ERROR: [number, HealthFlag][] = [
  [
    0,
    {
      level: 'warning',
      code: 'sis-error',
      text: 'Signal-in-space error (a satellite broadcasts an error)',
    },
  ],
  [
    1,
    {
      level: 'warning',
      code: 'diffcorr-error',
      text: 'Differential-correction input error',
    },
  ],
  [
    2,
    {
      level: 'warning',
      code: 'ext-sensor-error',
      text: 'External sensor error',
    },
  ],
  [3, { level: 'warning', code: 'setup-error', text: 'Setup error' }],
];

export interface SbfHealthResult {
  /** One record per ReceiverStatus / RFStatus block, in stream order. */
  records: ReceiverHealthRecord[];
  /** Health blocks seen. */
  messages: number;
}

/** Decode every ReceiverStatus (4014) and RFStatus (4092) block. */
export function parseSbfHealth(data: Uint8Array): SbfHealthResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: ReceiverHealthRecord[] = [];
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4014 && id !== 4092) return;
    if (len < 20) return;
    const tow = view.getUint32(b + 8, true);
    const wnc = view.getUint16(b + 12, true);
    const timeMs =
      tow === 0xffffffff || wnc === 0xffff
        ? null
        : GPS_EPOCH_MS + wnc * 604800000 + tow;

    if (id === 4014) {
      if (len < 32) return;
      messages++;
      const rev = view.getUint16(b + 4, true) >> 13;
      const cpu = view.getUint8(b + 14);
      const ext = view.getUint8(b + 15);
      const upTime = view.getUint32(b + 16, true);
      const rxState = view.getUint32(b + 20, true);
      const rxError = view.getUint32(b + 24, true);
      const n = view.getUint8(b + 28);
      const sbLen = view.getUint8(b + 29);
      // Rev 1 added CmdCount + Temperature (°C + 100; 0 = do-not-use).
      const tempRaw = rev >= 1 ? view.getUint8(b + 31) : 0;

      const bands: RfBandHealth[] = [];
      // Gain = −128 is the guide's do-not-use for "front-end PLL not locked".
      const unlocked: string[] = [];
      if (sbLen >= 4) {
        for (let k = 0; k < n && b + 32 + (k + 1) * sbLen <= b + len; k++) {
          const o = b + 32 + k * sbLen;
          const fe = view.getUint8(o);
          const gain = view.getInt8(o + 1);
          const blank = view.getUint8(o + 3);
          const band = FRONTEND[fe & 0x1f] ?? `frontend ${fe & 0x1f}`;
          if (gain === -128) unlocked.push(band);
          bands.push({
            band,
            antenna: fe >> 5,
            agcGainDb: gain === -128 ? null : gain,
            agcPct: null,
            noisePerMs: null,
            jamIndicator: null,
            blankingPct: blank === 255 ? null : blank,
            jamming: 'unknown',
          });
        }
      }

      const flags: HealthFlag[] = [];
      for (const [bit, f] of RX_ERROR) if (rxError & (1 << bit)) flags.push(f);
      for (const [bit, f] of EXT_ERROR) if (ext & (1 << bit)) flags.push(f);
      if (unlocked.length)
        flags.push({
          level: 'error',
          code: 'frontend-pll',
          text: `RF front-end PLL not locked: ${unlocked.join(', ')}`,
        });

      const short = (rxError & (1 << 5)) !== 0;
      const active = (rxState & (1 << 1)) !== 0;
      records.push({
        timeMs,
        source: 'ReceiverStatus',
        cpuLoadPct: cpu === 255 ? null : cpu,
        temperatureC: tempRaw === 0 ? null : tempRaw - 100,
        uptimeS: upTime === 0xffffffff ? null : upTime,
        antennas: [
          {
            antenna: 0,
            // ACTIVEANTENNA = an active antenna draws current; unset can be
            // a passive antenna, so it is not reported as 'open'. With two
            // antennas the bit alternates main/aux every 10 s (SBF guide).
            state: short ? 'short' : active ? 'ok' : 'unknown',
            voltageV: null,
            currentMa: null,
          },
        ],
        bands,
        flags,
      });
      return;
    }

    // RFStatus (4092)
    messages++;
    const n = view.getUint8(b + 14);
    const sbLen = view.getUint8(b + 15);
    const flagsByte = view.getUint8(b + 16);
    const interference: InterferenceReport[] = [];
    if (sbLen >= 8) {
      for (let k = 0; k < n && b + 20 + (k + 1) * sbLen <= b + len; k++) {
        const o = b + 20 + k * sbLen;
        const freqHz = view.getUint32(o, true);
        const bwKHz = view.getUint16(o + 4, true);
        const info = view.getUint8(o + 6);
        const power = view.getInt8(o + 7); // dBm, 0 = not estimated
        // Mode (bits 0–3) is an enum: 1 manual notch, 2 detected and
        // cancelled, 8 detected, not mitigated.
        const mode = info & 0x0f;
        const state =
          mode === 8
            ? 'detected'
            : mode === 2
              ? 'mitigated'
              : mode === 1
                ? 'suppressed'
                : null;
        if (!state) continue;
        interference.push({
          band: `${(freqHz / 1e6).toFixed(2)} MHz`,
          antenna: info >> 6,
          centerMHz: freqHz / 1e6,
          bandwidthMHz: bwKHz / 1000,
          powerDbm: power === 0 ? null : power,
          state,
          method: null,
        });
      }
    }
    const flags: HealthFlag[] = [];
    if (interference.some((i) => i.state === 'detected'))
      flags.push({
        level: 'warning',
        code: 'interference',
        text: 'Interference present and not mitigated',
      });
    const spoofing = (flagsByte & 0x03) !== 0;
    if (flagsByte & 0x01)
      flags.push({
        level: 'error',
        code: 'spoofing',
        text: 'Spoofing detected by the signal authenticity test',
      });
    if (flagsByte & 0x02)
      flags.push({
        level: 'error',
        code: 'spoofing-osnma',
        text: 'Spoofing detected by Galileo OSNMA',
      });
    records.push({
      timeMs,
      source: 'RFStatus',
      interference,
      spoofing,
      flags,
    });
  });

  return { records, messages };
}
