import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  Rtcm2Decoder,
  rtcm2Station,
  rtcm2Observation,
  rtcm2Dgps,
  looksLikeRtcm2,
} from '../src/rtcm2';

const FIXTURE = new URL(
  '../test-fixtures/rtcm2_avl12_slice.bin',
  import.meta.url
).pathname;

describe.skipIf(!existsSync(FIXTURE))(
  'RTCM 2.x decoder (real AVL12 capture)',
  () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));

    it('detects the RTCM2 6-of-8 stream', () => {
      expect(looksLikeRtcm2(bytes)).toBe(true);
    });

    it('frames and parity-checks the stream', () => {
      const frames = new Rtcm2Decoder().decode(bytes);
      expect(frames.length).toBeGreaterThan(50);
      const types = new Set(frames.map((f) => f.messageType));
      // AVL12 sends 1 (DGPS), 3/22 (station), 18/19 (RTK obs), 31 (GLO DGPS)
      for (const t of [1, 3, 18, 19, 22]) expect(types.has(t)).toBe(true);
      // every frame carries a plausible station ID
      expect(frames.every((f) => f.stationId > 0)).toBe(true);
    });

    it('decodes the reference-station position (Type 3) onto the Earth', () => {
      const frames = new Rtcm2Decoder().decode(bytes);
      const t3 = frames.find((f) => f.messageType === 3)!;
      const st = rtcm2Station(t3)!;
      const [x, y, z] = st.position!;
      const r = Math.hypot(x, y, z);
      expect(r).toBeGreaterThan(6.3e6); // Earth surface ~6.37e6 m
      expect(r).toBeLessThan(6.4e6);
    });

    it('decodes RTK carrier phase (18) and pseudorange (19) records', () => {
      const frames = new Rtcm2Decoder().decode(bytes);
      const t18 = frames.find((f) => f.messageType === 18)!;
      const o18 = rtcm2Observation(t18)!;
      expect(o18.records.length).toBeGreaterThan(0);
      expect(o18.records[0]!.phaseCycles).toBeTypeOf('number');

      const t19 = frames.find((f) => f.messageType === 19)!;
      const o19 = rtcm2Observation(t19)!;
      expect(o19.records.length).toBeGreaterThan(0);
      const pr = o19.records[0]!.pseudorangeM!;
      expect(pr).toBeGreaterThan(0); // modulo-ms range, positive
    });

    it('decodes GPS differential corrections (Type 1)', () => {
      const frames = new Rtcm2Decoder().decode(bytes);
      const t1 = frames.find((f) => f.messageType === 1)!;
      const d = rtcm2Dgps(t1)!;
      expect(d.system).toBe('G');
      expect(d.corrections.length).toBeGreaterThan(0);
      expect(d.corrections[0]!.prn).toMatch(/^G\d\d$/);
    });
  }
);

describe('RTCM2 detection rejects non-RTCM2', () => {
  it('rejects a non-6-of-8 buffer', () => {
    expect(looksLikeRtcm2(new Uint8Array([0xd3, 0x00, 0x13, 0x01]))).toBe(
      false
    );
  });
});
