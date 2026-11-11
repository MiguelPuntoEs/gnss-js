/**
 * u-blox receiver health: UBX-MON-HW (0x0A 0x09) — antenna supervisor,
 * AGC, noise and jamming state (legacy, one RF path); UBX-MON-RF (0x0A 0x38)
 * — the same per RF block (L1, L2/L5) on F9 and later; UBX-MON-SYS
 * (0x0A 0x39) — CPU load, uptime and temperature.
 *
 * MON-HW per the u-blox 8/M8 protocol spec (UBX-13003221 §31.17.3); MON-RF
 * and MON-SYS (F9 and later, not in that spec) per pyubx2. No public capture
 * carries these messages yet, so the decoder is tested on byte-built frames.
 */
import { ubxFrames } from './frame';
import type {
  AntennaHealth,
  AntennaState,
  HealthFlag,
  JammingState,
  ReceiverHealthRecord,
  RfBandHealth,
} from '../receiver-health';

const AGC_FULL_SCALE = 8191;

function antennaState(status: number, power: number): AntennaState {
  if (power === 0) return 'off';
  if (status === 2) return 'ok';
  if (status === 3) return 'short';
  if (status === 4) return 'open';
  return 'unknown'; // INIT / DONTKNOW (supervisor not configured)
}

function jammingState(s: number): JammingState {
  return s === 1
    ? 'none'
    : s === 2
      ? 'warning'
      : s === 3
        ? 'critical'
        : 'unknown';
}

function antennaFlags(a: AntennaHealth): HealthFlag[] {
  const which = a.antenna === 0 ? 'Antenna' : `Antenna ${a.antenna + 1}`;
  if (a.state === 'short')
    return [
      { level: 'error', code: 'antenna-short', text: `${which} short circuit` },
    ];
  if (a.state === 'open')
    return [
      {
        level: 'warning',
        code: 'antenna-open',
        text: `${which} open circuit (disconnected?)`,
      },
    ];
  if (a.state === 'off')
    return [
      { level: 'warning', code: 'antenna-off', text: `${which} power is off` },
    ];
  return [];
}

function jammingFlags(b: RfBandHealth): HealthFlag[] {
  if (b.jamming === 'critical')
    return [
      {
        level: 'error',
        code: 'jamming',
        text: `Jamming critical on ${b.band}: interference visible and no fix`,
      },
    ];
  if (b.jamming === 'warning')
    return [
      {
        level: 'warning',
        code: 'jamming',
        text: `Jamming warning on ${b.band}: interference visible, fix OK`,
      },
    ];
  return [];
}

export interface UbxHealthResult {
  /** One record per MON-HW / MON-RF / MON-SYS message, in stream order. */
  records: ReceiverHealthRecord[];
  messages: number;
}

/** Decode every MON-HW, MON-RF and MON-SYS message in a u-blox stream. */
export function parseUbxHealth(data: Uint8Array): UbxHealthResult {
  const records: ReceiverHealthRecord[] = [];
  let messages = 0;
  let sawMonRf = false;

  for (const f of ubxFrames(data)) {
    if (f.msgClass !== 0x0a) continue;
    const p = f.payload;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);

    if (f.msgId === 0x09 && p.length >= 60) {
      messages++;
      const antenna: AntennaHealth = {
        antenna: 0,
        state: antennaState(p[20]!, p[21]!),
        voltageV: null,
        currentMa: null,
      };
      const band: RfBandHealth = {
        band: 'L1',
        antenna: 0,
        agcGainDb: null,
        agcPct: (v.getUint16(18, true) / AGC_FULL_SCALE) * 100,
        noisePerMs: v.getUint16(16, true),
        jamIndicator: p[45]!,
        blankingPct: null,
        jamming: jammingState((p[22]! >> 2) & 0x03),
      };
      records.push({
        timeMs: null,
        source: 'MON-HW',
        antennas: [antenna],
        bands: [band],
        flags: [...antennaFlags(antenna), ...jammingFlags(band)],
      });
    } else if (f.msgId === 0x38 && p.length >= 4) {
      messages++;
      sawMonRf = true;
      const n = p[1]!;
      const antennas: AntennaHealth[] = [];
      const bands: RfBandHealth[] = [];
      for (let k = 0; k < n && 4 + (k + 1) * 24 <= p.length; k++) {
        const o = 4 + k * 24;
        const blockId = p[o]!;
        // Block 0 is L1; block 1 is L2 or L5 depending on the product.
        const label =
          blockId === 0
            ? 'L1'
            : blockId === 1
              ? 'L2/L5'
              : `RF block ${blockId}`;
        const ant: AntennaHealth = {
          antenna: 0,
          state: antennaState(p[o + 2]!, p[o + 3]!),
          voltageV: null,
          currentMa: null,
        };
        // One antenna feeds every block; keep the first informative state.
        if (!antennas.length || antennas[0]!.state === 'unknown')
          antennas[0] = ant;
        bands.push({
          band: label,
          antenna: 0,
          agcGainDb: null,
          agcPct: (v.getUint16(o + 14, true) / AGC_FULL_SCALE) * 100,
          noisePerMs: v.getUint16(o + 12, true),
          jamIndicator: p[o + 16]!,
          blankingPct: null,
          jamming: jammingState(p[o + 1]! & 0x03),
        });
      }
      records.push({
        timeMs: null,
        source: 'MON-RF',
        antennas,
        bands,
        flags: [
          ...antennas.flatMap(antennaFlags),
          ...bands.flatMap(jammingFlags),
        ],
      });
    } else if (f.msgId === 0x39 && p.length >= 24) {
      messages++;
      records.push({
        timeMs: null,
        source: 'MON-SYS',
        cpuLoadPct: p[2]!,
        uptimeS: v.getUint32(8, true),
        temperatureC: v.getInt8(18),
      });
    }
  }

  // MON-RF supersedes MON-HW's single-path view; avoid a duplicate L1 row.
  if (sawMonRf)
    for (const r of records)
      if (r.source === 'MON-HW') {
        delete r.bands;
        delete r.flags;
        r.flags = (r.antennas ?? []).flatMap(antennaFlags);
      }

  return { records, messages };
}
