import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BitReader, Rtcm3Decoder } from '../src/rtcm3/decoder';
import { createStationMeta, updateStationMeta } from '../src/rtcm3/station';
import {
  decodeGloBiases,
  encodeGloBiases,
  encodeStationArp,
  encodeStationDescriptors,
} from '../src/rtcm3/station-encode';

const frames = new Rtcm3Decoder().decode(
  new Uint8Array(
    readFileSync(
      join(__dirname, '..', 'test-fixtures', 'dlf100_rtcm_rtk_base.rtcm')
    )
  )
);
const first = (type: number) => frames.find((f) => f.messageType === type)!;
const reframe = (bytes: Uint8Array) => new Rtcm3Decoder().decode(bytes)[0]!;

describe('station message encoders (DLF100 bit-exact)', () => {
  it('1006 re-encodes from its decoded fields', () => {
    const f = first(1006);
    const meta = createStationMeta();
    updateStationMeta(meta, f);
    // The indicator bits are not in StationMeta: read them for the round trip.
    const r = new BitReader(f.payload);
    r.skip(30);
    const [gps, glo, gal, nonPhys] = [
      r.readU(1),
      r.readU(1),
      r.readU(1),
      r.readU(1),
    ];
    r.skip(38);
    const osc = r.readU(1);
    r.skip(39);
    const qc = r.readU(2);
    const out = reframe(
      encodeStationArp({
        stationId: meta.stationId!,
        position: meta.position!,
        antennaHeight: meta.antennaHeight!,
        itrf: meta.itrf!,
        gps: gps === 1,
        glonass: glo === 1,
        galileo: gal === 1,
        nonPhysical: nonPhys === 1,
        singleOscillator: osc === 1,
        quarterCycle: qc,
      })
    );
    expect(out.payload).toEqual(f.payload);
  });

  it('1005 is 1006 without the height', () => {
    const out = reframe(
      encodeStationArp({
        stationId: 7,
        position: [3924698.0761, 301124.6372, 5001904.9128],
      })
    );
    expect(out.messageType).toBe(1005);
    expect(out.length).toBe(19);
    const meta = createStationMeta();
    updateStationMeta(meta, out);
    expect(meta.stationId).toBe(7);
    meta.position!.forEach((v, i) =>
      expect(v).toBeCloseTo([3924698.0761, 301124.6372, 5001904.9128][i]!, 4)
    );
    expect(meta.antennaHeight).toBeNull();
  });

  it('1033 re-encodes from its decoded fields', () => {
    const f = first(1033);
    const meta = createStationMeta();
    updateStationMeta(meta, f);
    const out = reframe(
      encodeStationDescriptors({
        stationId: meta.stationId!,
        antennaType: meta.antennaType ?? undefined,
        antennaSetupId: meta.antennaSetupId ?? 0,
        antennaSerial: meta.antennaSerial ?? undefined,
        receiverType: meta.receiverType ?? undefined,
        receiverFirmware: meta.receiverFirmware ?? undefined,
        receiverSerial: meta.receiverSerial ?? undefined,
      })
    );
    expect(out.payload).toEqual(f.payload);
  });

  it('1230 decodes and re-encodes', () => {
    const f = first(1230);
    const b = decodeGloBiases(f)!;
    expect(b.stationId).toBe(new BitReader(f.payload).readU(24) & 0xfff);
    expect(reframe(encodeGloBiases(b)).payload).toEqual(f.payload);
  });

  it('refuses descriptors longer than 31 characters', () => {
    expect(() =>
      encodeStationDescriptors({ stationId: 0, antennaType: 'X'.repeat(32) })
    ).toThrow(RangeError);
  });
});
