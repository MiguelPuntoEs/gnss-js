/** Two vs all frequencies on one RINEX day against a known coordinate:
 *  node multi.mjs obs sp3 clk|- atx truthX,Y,Z [systems] [hours] [json opts] */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { parseSp3 } from '../../src/rinex/sp3';
import { parseClk } from '../../src/rinex/clk';
import { parseAntex } from '../../src/antex';
import {
  solvePpp,
  buildPppAntenna,
  createPppCorrections,
  type PppEpochResult,
} from '../../src/positioning';
import {
  solvePppUncombined,
  type PppUncombinedOptions,
} from '../../src/positioning/ppp-uncombined';
import { getEnuDifference } from '../../src/coordinates';
import { loadMulti, toDual, firstTwo } from './load';

const txt = (p: string) => {
  const b = readFileSync(p);
  return (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString(
    'latin1'
  );
};
const [obsP, sp3P, clkP, atxP, truthS, systems = 'GE', hours = '24', extra] =
  process.argv.slice(2);
const truth = truthS!.split(',').map(Number) as [number, number, number];
const sp3 = parseSp3(txt(sp3P!));
const clk = clkP && clkP !== '-' ? parseClk(txt(clkP)) : undefined;
const antenna = buildPppAntenna(parseAntex(txt(atxP!)));
const { header, multi: all } = await loadMulti(obsP!, { systems });
const tEnd = all[0]!.timeMs + Number(hours) * 3600e3;
const multi = all.filter((e) => e.timeMs < tEnd);
const delta = header.antDelta ?? [0, 0, 0];
const corr = () =>
  createPppCorrections({
    antenna,
    rcvAntType: header.antType ?? '',
    antDeltaEnu: [delta[1], delta[2], delta[0]],
  });
const base = {
  aprioriPos: header.approxPosition as [number, number, number],
  ...(clk ? { clk } : {}),
  estimateGradients: true,
};
const nSig = new Map<string, number>();
for (const e of multi)
  for (const o of e.obs)
    for (const s of o.signals) {
      const k = o.prn[0]! + s.band + s.code.slice(1);
      nSig.set(k, (nSig.get(k) ?? 0) + 1);
    }
console.log(
  header.antType,
  header.receiverType,
  [...nSig].map(([k, n]) => `${k}:${n}`).join(' ')
);
const ucOpts: Partial<PppUncombinedOptions> = extra ? JSON.parse(extra) : {};
const runs: [
  string,
  () => {
    series: PppEpochResult[];
    position: number[];
    resets?: Record<string, number>;
  },
][] = [
  [
    'IF',
    () =>
      solvePpp(toDual(firstTwo(multi)), sp3, {
        ...base,
        corrections: corr(),
      }),
  ],
  [
    'UC2',
    () =>
      solvePppUncombined(firstTwo(multi), sp3, {
        ...base,
        corrections: corr(),
        ...ucOpts,
      }),
  ],
  [
    'UCall',
    () =>
      solvePppUncombined(multi, sp3, {
        ...base,
        corrections: corr(),
        ...ucOpts,
      }),
  ],
];
const marks = [0.25, 0.5, 1, 2, 4, 8, 24].filter((h) => h <= Number(hours));
console.log('run     ' + marks.map((h) => `${h} h`.padStart(18)).join(''));
for (const [name, run] of runs) {
  const t = Date.now();
  const sol = run();
  const s = (Date.now() - t) / 1000;
  const cells = marks.map((h) => {
    const i = multi.findIndex((e) => e.timeMs >= multi[0]!.timeMs + h * 3600e3);
    const r = sol.series[i < 0 ? sol.series.length - 1 : i - 1]!;
    const d = getEnuDifference(
      r.position[0],
      r.position[1],
      r.position[2],
      truth[0],
      truth[1],
      truth[2]
    );
    return d
      .map((v) => (v * 1000).toFixed(1))
      .join('/')
      .padStart(18);
  });
  console.log(
    name.padEnd(8) +
      cells.join('') +
      `  (${s.toFixed(1)} s)` +
      (sol.resets ? ' resets ' + JSON.stringify(sol.resets) : '')
  );
}
