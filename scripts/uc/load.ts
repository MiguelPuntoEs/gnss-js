/** Dev harness helpers: read a RINEX file into multi-signal PPP epochs. */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { parseRinexStream } from '../../src/rinex';
import { buildGloChannelMap } from '../../src/constants/gnss';
import {
  selectPppSignals,
  toDualFrequencyObs,
  type PppMultiEpoch,
  type PppEpoch,
  type SelectPppSignalsOptions,
} from '../../src/positioning';

export async function loadMulti(
  path: string,
  opts: { systems?: string; bands?: SelectPppSignalsOptions['bands'] } = {}
) {
  let bytes: Uint8Array = new Uint8Array(readFileSync(path));
  let name = path.split('/').pop()!;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(gunzipSync(bytes));
    name = name.replace(/\.gz$/, '');
  }
  const raw: {
    t: number;
    prn: string;
    codes: string[];
    values: (number | null)[];
    lli?: (number | null)[];
  }[] = [];
  const res = await parseRinexStream(
    new File([bytes as BlobPart], name),
    undefined,
    undefined,
    (t, prn, codes, values, lli) => {
      if (opts.systems && !opts.systems.includes(prn[0]!)) return;
      raw.push({ t, prn, codes, values, ...(lli ? { lli } : {}) });
    },
    true
  );
  const glo = buildGloChannelMap(res.header.glonassSlots ?? {});
  const byT = new Map<number, PppMultiEpoch['obs']>();
  for (const r of raw) {
    const s = selectPppSignals(r.prn, r.codes, r.values, {
      gloChannels: glo,
      ...(r.lli ? { lli: r.lli } : {}),
      ...(opts.bands ? { bands: opts.bands } : {}),
    });
    if (!s) continue;
    let a = byT.get(r.t);
    if (!a) byT.set(r.t, (a = []));
    a.push(s);
  }
  const multi: PppMultiEpoch[] = [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, obs]) => ({ timeMs, obs }));
  return { header: res.header, multi };
}

/** The ionosphere-free engine's epochs from the same records. */
export function toDual(multi: PppMultiEpoch[]): PppEpoch[] {
  return multi.map((e) => ({
    timeMs: e.timeMs,
    obs: e.obs
      .map((o) => toDualFrequencyObs(o))
      .filter((o): o is NonNullable<typeof o> => !!o),
  }));
}

/** Only the first two signals per satellite (and only satellites with two). */
export function firstTwo(multi: PppMultiEpoch[]): PppMultiEpoch[] {
  return multi.map((e) => ({
    timeMs: e.timeMs,
    obs: e.obs
      .filter((o) => o.signals.length >= 2)
      .map((o) => ({ prn: o.prn, signals: o.signals.slice(0, 2) })),
  }));
}
