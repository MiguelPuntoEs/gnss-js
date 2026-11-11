/**
 * NovAtel OEM7 receiver health: HWMONITOR (963) — temperature, antenna
 * current/voltage and supply rails, each with the receiver's own boundary
 * status; RXSTATUS (93) — receiver error word plus status/aux words
 * (temperature, voltage, antenna power/open/short, LNA, CPU overload,
 * jammer per RF path, spoofing); ITDETECTSTATUS (2065) — detected
 * interferers (spectrum analysis: centre, bandwidth, power).
 *
 * Layouts per the OEM7 Commands and Logs Reference Manual; the HWMONITOR
 * test vector is the manual's own ASCII example. No public binary capture
 * carries these logs yet.
 */
import { oem4Frames } from './frame';
import type {
  AntennaHealth,
  HealthFlag,
  InterferenceReport,
  ReceiverHealthRecord,
} from '../receiver-health';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const HWMONITOR = 963;
const RXSTATUS = 93;
const ITDETECTSTATUS = 2065;

/** HWMONITOR reading types (status bits 8–15) worth naming in a flag. */
const READING_NAME: Record<number, string> = {
  0x01: 'Temperature',
  0x02: 'Antenna current',
  0x06: '3.3 V supply',
  0x07: 'Antenna voltage',
  0x08: '1.2 V core supply',
  0x0f: 'Supply voltage',
  0x11: '1.8 V supply',
  0x15: '5 V supply',
  0x16: 'Secondary temperature',
  0x17: 'Peripheral core voltage',
  0x18: 'Secondary antenna current',
  0x19: 'Secondary antenna voltage',
};

/** RXSTATUS receiver-error word bits → description. */
const RX_ERROR: [number, string][] = [
  [0, 'DRAM failure'],
  [1, 'invalid firmware'],
  [2, 'ROM failure'],
  [4, 'ESN access failure'],
  [5, 'authorization code error'],
  [7, 'supply voltage error'],
  [9, 'temperature out of limits'],
  [10, 'MINOS error'],
  [11, 'RF PLL error'],
  [15, 'NVM error'],
  [16, 'software resource limit exceeded'],
  [17, 'model invalid for this receiver'],
  [21, 'export restriction'],
  [22, 'safe mode'],
  [31, 'component hardware failure'],
];

/** ITDETECTSTATUS RF path enum. */
const RF_PATH: Record<number, string> = { 2: 'L1', 3: 'L2', 5: 'L5' };

/** RXSTATUS aux1 jammer bits → RF path number. */
const AUX1_JAMMER: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [4, 4],
  [5, 5],
  [6, 6],
];

export interface NovatelHealthResult {
  /** One record per HWMONITOR / RXSTATUS / ITDETECTSTATUS log. */
  records: ReceiverHealthRecord[];
  messages: number;
}

/** Decode every binary HWMONITOR, RXSTATUS and ITDETECTSTATUS log. */
export function parseNovatelHealth(data: Uint8Array): NovatelHealthResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: ReceiverHealthRecord[] = [];
  let messages = 0;
  const stats = { badCrc: 0 };

  for (const f of oem4Frames(data, view, stats)) {
    if (!f.binary) continue;
    if (f.id !== HWMONITOR && f.id !== RXSTATUS && f.id !== ITDETECTSTATUS)
      continue;
    const p = f.payload;
    const timeMs = GPS_EPOCH_MS + f.week * 604800000 + f.towMs;
    // Header message-type bits 0–4: measurement source (1 = 2nd antenna).
    const antenna = data[f.start + 6]! & 0x01;

    if (f.id === HWMONITOR) {
      if (f.msgLen < 4) continue;
      const n = view.getUint32(p, true);
      if (4 + n * 8 > f.msgLen) continue;
      messages++;
      let temperatureC: number | null = null;
      const ant: AntennaHealth[] = [
        { antenna: 0, state: 'unknown', voltageV: null, currentMa: null },
        { antenna: 1, state: 'unknown', voltageV: null, currentMa: null },
      ];
      const flags: HealthFlag[] = [];
      for (let k = 0; k < n; k++) {
        const value = view.getFloat32(p + 4 + k * 8, true);
        const status = view.getUint32(p + 8 + k * 8, true);
        const type = (status >> 8) & 0xff;
        const bound = status & 0xff;
        if (type === 0x01) temperatureC = value;
        else if (type === 0x02) ant[0]!.currentMa = value * 1000;
        else if (type === 0x07) ant[0]!.voltageV = value;
        else if (type === 0x18) ant[1]!.currentMa = value * 1000;
        else if (type === 0x19) ant[1]!.voltageV = value;
        if (bound >= 1 && bound <= 4) {
          const name = READING_NAME[type] ?? `Reading 0x${type.toString(16)}`;
          const under = bound <= 2;
          flags.push({
            level: bound === 2 || bound === 4 ? 'error' : 'warning',
            code: `hw-${type.toString(16)}`,
            text: `${name} ${under ? 'below' : 'above'} its ${
              bound === 2 || bound === 4 ? 'error' : 'warning'
            } limit (${value.toPrecision(4)})`,
          });
        }
      }
      records.push({
        timeMs,
        source: 'HWMONITOR',
        temperatureC,
        antennas: ant.filter((a) => a.voltageV != null || a.currentMa != null),
        flags,
      });
      continue;
    }

    if (f.id === RXSTATUS) {
      if (f.msgLen < 8) continue;
      const error = view.getUint32(p, true);
      const nStats = view.getUint32(p + 4, true);
      if (nStats < 1 || f.msgLen < 8 + 16) continue;
      messages++;
      const word = (i: number) =>
        i < nStats && 8 + i * 16 + 4 <= f.msgLen
          ? view.getUint32(p + 8 + i * 16, true)
          : 0;
      const rx = word(0);
      const aux1 = word(1);
      const aux2 = word(2);
      const bit = (w: number, b: number) => (w & (1 << b)) !== 0;
      const flags: HealthFlag[] = [];

      if (error !== 0) {
        const what = RX_ERROR.filter(([b]) => bit(error, b)).map(([, t]) => t);
        flags.push({
          level: 'error',
          code: 'receiver-error',
          text: `Receiver error — ${what.length ? what.join(', ') : `code 0x${error.toString(16)}`}; channels idled`,
        });
      }
      if (bit(rx, 1))
        flags.push({
          level: 'warning',
          code: 'temperature',
          text: 'Temperature outside specification',
        });
      if (bit(rx, 2))
        flags.push({
          level: 'warning',
          code: 'voltage',
          text: 'Supply voltage warning',
        });
      if (bit(rx, 4))
        flags.push({
          level: 'error',
          code: 'lna-failure',
          text: 'Antenna LNA failure',
        });
      if (bit(rx, 7))
        flags.push({
          level: 'warning',
          code: 'cpu-overload',
          text: 'CPU overload',
        });
      if (bit(rx, 14))
        flags.push({
          level: 'warning',
          code: 'antenna-gain',
          text: 'Antenna gain out of range',
        });
      if (bit(rx, 15)) {
        const paths = AUX1_JAMMER.filter(([b]) => bit(aux1, b)).map(
          ([, rf]) => `RF${rf}`
        );
        flags.push({
          level: 'warning',
          code: 'jamming',
          text: `Jammer detected${paths.length ? ` on ${paths.join(', ')}` : ''}`,
        });
      }
      const spoofing = bit(rx, 9);
      if (spoofing)
        flags.push({
          level: 'error',
          code: 'spoofing',
          text: 'Spoofing detected',
        });

      const primary: AntennaHealth = {
        antenna: 0,
        state: bit(rx, 3)
          ? 'off'
          : bit(rx, 6)
            ? 'short'
            : bit(rx, 5)
              ? 'open'
              : 'ok',
        voltageV: null,
        currentMa: null,
      };
      const antennas = [primary];
      // Aux2 bits 29/30 exist only on dual-antenna products, so a clear bit
      // says nothing; report the secondary antenna only when it is faulty.
      if (bit(aux2, 30) || bit(aux2, 29)) {
        antennas.push({
          antenna: 1,
          state: bit(aux2, 30) ? 'short' : 'open',
          voltageV: null,
          currentMa: null,
        });
      }
      for (const a of antennas) {
        const which = a.antenna === 0 ? 'Antenna' : 'Secondary antenna';
        if (a.state === 'short')
          flags.push({
            level: 'error',
            code: 'antenna-short',
            text: `${which} short circuit`,
          });
        else if (a.state === 'open')
          flags.push({
            level: 'warning',
            code: 'antenna-open',
            text: `${which} open circuit (disconnected?)`,
          });
        else if (a.state === 'off')
          flags.push({
            level: 'warning',
            code: 'antenna-off',
            text: `${which} not powered`,
          });
      }
      records.push({ timeMs, source: 'RXSTATUS', antennas, spoofing, flags });
      continue;
    }

    // ITDETECTSTATUS
    if (f.msgLen < 4) continue;
    const n = view.getUint32(p, true);
    if (4 + n * 36 > f.msgLen) continue;
    messages++;
    const interference: InterferenceReport[] = [];
    for (let k = 0; k < n; k++) {
      const o = p + 4 + k * 36;
      const path = view.getUint32(o, true);
      const spectrum = view.getUint32(o + 4, true) === 0;
      interference.push({
        band: RF_PATH[path] ?? `RF path ${path}`,
        antenna,
        centerMHz: spectrum ? view.getFloat32(o + 8, true) : null,
        bandwidthMHz: spectrum ? view.getFloat32(o + 12, true) : null,
        powerDbm: spectrum ? view.getFloat32(o + 16, true) : null,
        state: 'detected',
        method: spectrum ? 'spectrum' : 'statistics',
      });
    }
    records.push({
      timeMs,
      // Per antenna: the second antenna's list must not replace the first's.
      source: antenna ? 'ITDETECTSTATUS_1' : 'ITDETECTSTATUS',
      interference,
      flags: interference.length
        ? [
            {
              level: 'warning',
              code: 'interference',
              text: `Interference detected on ${[...new Set(interference.map((i) => i.band))].join(', ')}${antenna ? ' (secondary antenna)' : ''}`,
            },
          ]
        : [],
    });
  }
  return { records, messages };
}
