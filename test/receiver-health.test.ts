import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfHealth } from '../src/sbf';
import { parseUbxHealth } from '../src/ubx';
import { parseNovatelHealth } from '../src/novatel';
import { summarizeReceiverHealth } from '../src/receiver-health';
import { crc16 } from '../src/sbf/frame';
import { crc32 } from '../src/novatel/frame';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

/** Frame an SBF block (sync, CRC16, id|rev<<13, length, body). */
function sbfFrame(id: number, rev: number, body: Uint8Array): Uint8Array {
  const len = Math.ceil((8 + body.length) / 4) * 4;
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  out[0] = 0x24;
  out[1] = 0x40;
  v.setUint16(4, id | (rev << 13), true);
  v.setUint16(6, len, true);
  out.set(body, 8);
  v.setUint16(2, crc16(out, 4, len), true);
  return out;
}

/** Frame a UBX message (sync, class, id, len, payload, Fletcher-8). */
function ubxFrame(cls: number, id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0xb5;
  out[1] = 0x62;
  out[2] = cls;
  out[3] = id;
  out[4] = payload.length & 0xff;
  out[5] = (payload.length >> 8) & 0xff;
  out.set(payload, 6);
  let a = 0;
  let b = 0;
  for (let j = 2; j < 6 + payload.length; j++) {
    a = (a + out[j]!) & 0xff;
    b = (b + a) & 0xff;
  }
  out[6 + payload.length] = a;
  out[7 + payload.length] = b;
  return out;
}

/** Frame a NovAtel OEM4 binary log with a valid CRC-32. */
function oem4Frame(
  id: number,
  week: number,
  towMs: number,
  body: Uint8Array,
  msgType = 0
): Uint8Array {
  const HLEN = 28;
  const out = new Uint8Array(HLEN + body.length + 4);
  const v = new DataView(out.buffer);
  out[0] = 0xaa;
  out[1] = 0x44;
  out[2] = 0x12;
  out[3] = HLEN;
  v.setUint16(4, id, true);
  out[6] = msgType;
  v.setUint16(8, body.length, true);
  v.setUint16(14, week, true);
  v.setUint32(16, towMs, true);
  out.set(body, HLEN);
  v.setUint32(HLEN + body.length, crc32(out, 0, HLEN + body.length), true);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const FIX = join(__dirname, '../test-fixtures/tudb_meas3_slice.sbf');

describe.skipIf(!existsSync(FIX))(
  'parseSbfHealth — real PolaRx5 ReceiverStatus (TU Delft TUDB)',
  () => {
    const res = existsSync(FIX)
      ? parseSbfHealth(new Uint8Array(readFileSync(FIX)))
      : null!;

    it('decodes every ReceiverStatus block', () => {
      expect(res.messages).toBe(13);
      expect(res.records.every((r) => r.source === 'ReceiverStatus')).toBe(
        true
      );
    });

    it('reads time, CPU, uptime and temperature', () => {
      const r = res.records[0]!;
      // Week 2428, 2026-07-21 00:00:10 GPS (the file is day 202, 00:00).
      expect(r.timeMs).toBe(GPS_EPOCH_MS + 2428 * 604800000 + 172810000);
      expect(r.cpuLoadPct).toBe(36);
      expect(r.uptimeS).toBe(12917247); // ~149.5 days
      expect(r.temperatureC).toBe(52);
    });

    it('lists the eight PolaRx5 front-ends with their AGC gains', () => {
      const bands = res.records[0]!.bands!;
      expect(bands.map((b) => b.band)).toEqual([
        'GPS L2',
        'GLO L2',
        'B3',
        'L5/E5a/B2a',
        'E5b/B2b',
        'GPS L1/E1',
        'GLO L1',
        'B1',
      ]);
      expect(bands.map((b) => b.agcGainDb)).toEqual([
        23, 24, 22, 20, 21, 25, 27, 26,
      ]);
      expect(bands.every((b) => b.antenna === 0 && b.blankingPct === 0)).toBe(
        true
      );
    });

    it('senses the active antenna and reports the latched software error', () => {
      const h = summarizeReceiverHealth(res.records);
      expect(h.antennas).toEqual([
        { antenna: 0, state: 'ok', voltageV: null, currentMa: null },
      ]);
      expect(h.flags.map((f) => f.code)).toEqual(['software']);
      expect(h.level).toBe('warning');
      expect(h.sources).toEqual({ ReceiverStatus: 13 });
    });
  }
);

describe('parseSbfHealth — RFStatus (4092)', () => {
  it('reads mitigated / detected bands and the OSNMA spoofing flag', () => {
    const body = new Uint8Array(12 + 2 * 8);
    const v = new DataView(body.buffer);
    v.setUint32(0, 345600000, true); // TOW
    v.setUint16(4, 2430, true); // WNc
    body[6] = 2; // N
    body[7] = 8; // SBLength
    body[8] = 0x02; // Flags: inauthentic (OSNMA)
    v.setUint32(12, 1575420000, true);
    v.setUint16(16, 2000, true); // kHz
    body[18] = 0x02; // mitigated, antenna 0
    v.setInt8(19, -95); // estimated power (dBm)
    v.setUint32(20, 1227600000, true);
    v.setUint16(24, 500, true);
    body[26] = 0x08 | (1 << 6); // detected, antenna 1
    const res = parseSbfHealth(sbfFrame(4092, 0, body));
    expect(res.messages).toBe(1);
    const r = res.records[0]!;
    expect(r.spoofing).toBe(true);
    expect(r.interference).toEqual([
      {
        band: '1575.42 MHz',
        antenna: 0,
        centerMHz: 1575.42,
        bandwidthMHz: 2,
        powerDbm: -95,
        state: 'mitigated',
        method: null,
      },
      {
        band: '1227.60 MHz',
        antenna: 1,
        centerMHz: 1227.6,
        bandwidthMHz: 0.5,
        powerDbm: null,
        state: 'detected',
        method: null,
      },
    ]);
    expect(r.flags!.map((f) => f.code)).toEqual([
      'interference',
      'spoofing-osnma',
    ]);
  });
});

describe('parseSbfHealth — ReceiverStatus fault flags', () => {
  it('flags a front end whose PLL is not locked (Gain = −128)', () => {
    const body = new Uint8Array(24 + 2 * 4);
    const v = new DataView(body.buffer);
    v.setUint32(0, 1000, true);
    v.setUint16(4, 2430, true);
    body[6] = 12; // CPULoad
    body[20] = 2; // N
    body[21] = 4; // SBLength
    body[23] = 140; // Temperature → 40 °C
    body[24] = 0; // GPS L1/E1
    v.setInt8(25, 30);
    body[28] = 5; // L5/E5a/B2a
    v.setInt8(29, -128); // PLL not locked
    const r = parseSbfHealth(sbfFrame(4014, 1, body)).records[0]!;
    expect(r.temperatureC).toBe(40);
    expect(r.bands!.map((b) => b.agcGainDb)).toEqual([30, null]);
    expect(r.flags).toEqual([
      {
        level: 'error',
        code: 'frontend-pll',
        text: 'RF front-end PLL not locked: L5/E5a/B2a',
      },
    ]);
  });
});

describe('parseUbxHealth', () => {
  const monRf = () => {
    const p = new Uint8Array(4 + 2 * 24);
    const v = new DataView(p.buffer);
    p[1] = 2; // nBlocks
    // Block 0: L1, jamming warning, antenna OK + powered.
    p[4] = 0;
    p[5] = 2;
    p[6] = 2;
    p[7] = 1;
    v.setUint16(4 + 12, 85, true); // noisePerMS
    v.setUint16(4 + 14, 4096, true); // agcCnt → 50 %
    p[4 + 16] = 120; // jamInd
    // Block 1: L2/L5, jamming critical.
    p[28] = 1;
    p[29] = 3;
    p[30] = 2;
    p[31] = 1;
    v.setUint16(28 + 14, 8191, true);
    p[28 + 16] = 250;
    return ubxFrame(0x0a, 0x38, p);
  };
  const monSys = () => {
    const p = new Uint8Array(24);
    const v = new DataView(p.buffer);
    p[2] = 41; // cpuLoad
    v.setUint32(8, 3600, true); // runTime
    v.setInt8(18, -5); // tempValue
    return ubxFrame(0x0a, 0x39, p);
  };
  const monHw = (aStatus: number, aPower: number) => {
    const p = new Uint8Array(60);
    const v = new DataView(p.buffer);
    v.setUint16(16, 90, true);
    v.setUint16(18, 2048, true);
    p[20] = aStatus;
    p[21] = aPower;
    p[22] = 1 << 2; // jammingState = ok
    p[45] = 7;
    return ubxFrame(0x0a, 0x09, p);
  };

  it('decodes MON-RF blocks, MON-SYS and flags jamming', () => {
    const res = parseUbxHealth(concat(monRf(), monSys()));
    expect(res.messages).toBe(2);
    const h = summarizeReceiverHealth(res.records);
    expect(h.cpuLoadPct).toBe(41);
    expect(h.uptimeS).toBe(3600);
    expect(h.temperatureC).toBe(-5);
    expect(h.timeMs).toBeNull();
    expect(h.bands).toHaveLength(2);
    expect(h.bands[0]).toMatchObject({
      band: 'L1',
      noisePerMs: 85,
      jamIndicator: 120,
      jamming: 'warning',
    });
    expect(h.bands[0]!.agcPct).toBeCloseTo(50.006, 2);
    expect(h.bands[1]).toMatchObject({ band: 'L2/L5', jamming: 'critical' });
    expect(h.bands[1]!.agcPct).toBeCloseTo(100, 6);
    expect(h.antennas[0]!.state).toBe('ok');
    expect(h.flags.map((f) => `${f.level}:${f.code}`)).toEqual([
      'warning:jamming',
      'error:jamming',
    ]);
    expect(h.level).toBe('error');
  });

  it('uses MON-HW alone on older receivers, and drops its row next to MON-RF', () => {
    const alone = summarizeReceiverHealth(parseUbxHealth(monHw(3, 1)).records);
    expect(alone.bands).toEqual([
      {
        band: 'L1',
        antenna: 0,
        agcGainDb: null,
        agcPct: (2048 / 8191) * 100,
        noisePerMs: 90,
        jamIndicator: 7,
        blankingPct: null,
        jamming: 'none',
      },
    ]);
    expect(alone.antennas[0]!.state).toBe('short');
    expect(alone.flags.map((f) => f.code)).toEqual(['antenna-short']);

    const both = summarizeReceiverHealth(
      parseUbxHealth(concat(monHw(2, 1), monRf())).records
    );
    expect(both.bands.map((b) => b.band)).toEqual(['L1', 'L2/L5']);
    expect(both.bands[0]!.jamIndicator).toBe(120); // MON-RF's, not MON-HW's
  });

  it('maps antenna power off / open', () => {
    expect(
      summarizeReceiverHealth(parseUbxHealth(monHw(2, 0)).records).antennas[0]!
        .state
    ).toBe('off');
    expect(
      summarizeReceiverHealth(parseUbxHealth(monHw(4, 1)).records).antennas[0]!
        .state
    ).toBe('open');
  });
});

describe('parseNovatelHealth', () => {
  it('decodes the OEM7 manual HWMONITOR example', () => {
    // #HWMONITORA,…;10,59.218563080,100,0.000122100,200,3.302808285,600,
    // 5.165323734,700,1.189255238,800,3.301587343,f00,1.835775375,1100,
    // 5.161416531,1500,1.554945111,1700,59.218563080,1600
    const readings: [number, number][] = [
      [59.21856308, 0x100],
      [0.0001221, 0x200],
      [3.302808285, 0x600],
      [5.165323734, 0x700],
      [1.189255238, 0x800],
      [3.301587343, 0xf00],
      [1.835775375, 0x1100],
      [5.161416531, 0x1500],
      [1.554945111, 0x1700],
      [59.21856308, 0x1600],
    ];
    const body = new Uint8Array(4 + readings.length * 8);
    const v = new DataView(body.buffer);
    v.setUint32(0, readings.length, true);
    readings.forEach(([val, st], k) => {
      v.setFloat32(4 + k * 8, val, true);
      v.setUint32(8 + k * 8, st, true);
    });
    const res = parseNovatelHealth(oem4Frame(963, 2209, 507561000, body));
    expect(res.messages).toBe(1);
    const r = res.records[0]!;
    expect(r.source).toBe('HWMONITOR');
    expect(r.timeMs).toBe(GPS_EPOCH_MS + 2209 * 604800000 + 507561000);
    expect(r.temperatureC!).toBeCloseTo(59.2186, 3);
    expect(r.antennas).toHaveLength(1);
    expect(r.antennas![0]!.voltageV!).toBeCloseTo(5.1653, 3);
    expect(r.antennas![0]!.currentMa!).toBeCloseTo(0.1221, 3);
    expect(r.flags).toEqual([]);
  });

  it('flags a HWMONITOR reading over its error limit', () => {
    const body = new Uint8Array(12);
    const v = new DataView(body.buffer);
    v.setUint32(0, 1, true);
    v.setFloat32(4, 0.21, true);
    v.setUint32(8, 0x204, true); // antenna current, over upper error limit
    const r = parseNovatelHealth(oem4Frame(963, 2209, 0, body)).records[0]!;
    expect(r.flags).toHaveLength(1);
    expect(r.flags![0]).toMatchObject({ level: 'error', code: 'hw-2' });
    expect(r.flags![0]!.text).toBe(
      'Antenna current above its error limit (210 mA)'
    );
  });

  const rxstatus = (error: number, words: number[]) => {
    const body = new Uint8Array(8 + words.length * 16);
    const v = new DataView(body.buffer);
    v.setUint32(0, error, true);
    v.setUint32(4, words.length, true);
    words.forEach((w, i) => v.setUint32(8 + i * 16, w, true));
    return oem4Frame(93, 2210, 333374033, body);
  };

  it('decodes the OEM7 manual RXSTATUS example (antenna open)', () => {
    // <RXSTATUS … 00000000 5  02000020 … 00040000 … 00000000 … 82000000 … 0030c000
    const r = parseNovatelHealth(
      rxstatus(0, [0x02000020, 0x00040000, 0, 0x82000000, 0x0030c000])
    ).records[0]!;
    expect(r.antennas).toEqual([
      { antenna: 0, state: 'open', voltageV: null, currentMa: null },
    ]);
    expect(r.spoofing).toBe(false);
    expect(r.flags!.map((f) => f.code)).toEqual(['antenna-open']);
  });

  it('decodes receiver error, jammer per RF path, spoofing, secondary short', () => {
    const rx = (1 << 7) | (1 << 9) | (1 << 15);
    const aux1 = (1 << 0) | (1 << 2); // RF1, RF3
    const aux2 = 1 << 30; // secondary antenna short
    const r = parseNovatelHealth(rxstatus(1 << 9, [rx, aux1, aux2]))
      .records[0]!;
    expect(r.spoofing).toBe(true);
    expect(r.flags!.map((f) => `${f.level}:${f.code}`)).toEqual([
      'error:receiver-error',
      'warning:cpu-overload',
      'warning:jamming',
      'error:spoofing',
      'error:antenna-short',
    ]);
    expect(r.flags![0]!.text).toContain('temperature out of limits');
    expect(r.flags![2]!.text).toBe('Jammer detected on RF1, RF3');
    expect(r.antennas!.map((a) => `${a.antenna}:${a.state}`)).toEqual([
      '0:ok',
      '1:short',
    ]);
  });

  it('decodes the OEM7 manual ITDETECTSTATUS example', () => {
    const entries: [number, number, number[]][] = [
      [2, 1, [-0.718, 29.167, 0.126, 12.797]],
      [3, 0, [1249.961, 71.191, -56.769, -132.907]],
      [3, 0, [1289.512, 1.978, -75.967, -138.493]],
    ];
    const body = new Uint8Array(4 + entries.length * 36);
    const v = new DataView(body.buffer);
    v.setUint32(0, entries.length, true);
    entries.forEach(([path, type, params], k) => {
      const o = 4 + k * 36;
      v.setUint32(o, path, true);
      v.setUint32(o + 4, type, true);
      params.forEach((x, j) => v.setFloat32(o + 8 + j * 4, x, true));
    });
    const res = parseNovatelHealth(oem4Frame(2065, 1982, 430605267, body));
    const it = res.records[0]!.interference!;
    expect(it.map((i) => `${i.band}:${i.method}`)).toEqual([
      'L1:statistics',
      'L2:spectrum',
      'L2:spectrum',
    ]);
    expect(it[0]!.centerMHz).toBeNull();
    expect(it[1]!.centerMHz!).toBeCloseTo(1249.961, 3);
    expect(it[1]!.bandwidthMHz!).toBeCloseTo(71.191, 3);
    expect(it[1]!.powerDbm!).toBeCloseTo(-56.769, 3);
    expect(res.records[0]!.flags![0]!.text).toBe(
      'Interference detected on L1, L2'
    );
  });

  it('keeps per-antenna ITDETECTSTATUS lists apart', () => {
    const one = (msgType: number) => {
      const body = new Uint8Array(4 + 36);
      const v = new DataView(body.buffer);
      v.setUint32(0, 1, true);
      v.setUint32(4, 2, true);
      v.setUint32(8, 1, true);
      return oem4Frame(2065, 1982, 0, body, msgType);
    };
    const h = summarizeReceiverHealth(
      parseNovatelHealth(concat(one(0), one(1))).records
    );
    expect(h.interference.map((i) => i.antenna)).toEqual([0, 1]);
  });
});

describe('summarizeReceiverHealth', () => {
  it('a later message from the same source clears its flags', () => {
    const h = summarizeReceiverHealth([
      {
        timeMs: 1000,
        source: 'RXSTATUS',
        flags: [{ level: 'error', code: 'spoofing', text: 'x' }],
        spoofing: true,
      },
      { timeMs: 2000, source: 'HWMONITOR', temperatureC: 40, flags: [] },
      { timeMs: 3000, source: 'RXSTATUS', flags: [], spoofing: false },
    ]);
    expect(h.flags).toEqual([]);
    expect(h.level).toBe('ok');
    expect(h.spoofing).toBe(false);
    expect(h.temperatureC).toBe(40);
    expect(h.timeMs).toBe(3000);
  });

  it('keeps antenna voltage from HWMONITOR alongside RXSTATUS state', () => {
    const h = summarizeReceiverHealth([
      {
        timeMs: 1,
        source: 'HWMONITOR',
        antennas: [
          { antenna: 0, state: 'unknown', voltageV: 5.1, currentMa: 40 },
        ],
      },
      {
        timeMs: 2,
        source: 'RXSTATUS',
        antennas: [
          { antenna: 0, state: 'ok', voltageV: null, currentMa: null },
        ],
      },
    ]);
    expect(h.antennas).toEqual([
      { antenna: 0, state: 'ok', voltageV: 5.1, currentMa: 40 },
    ]);
  });

  it('empty input is a clean, empty picture', () => {
    const h = summarizeReceiverHealth([]);
    expect(h).toMatchObject({
      level: 'ok',
      flags: [],
      bands: [],
      timeMs: null,
    });
  });
});
