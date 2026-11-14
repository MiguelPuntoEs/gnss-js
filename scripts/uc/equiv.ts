/** IF vs uncombined on one RINEX day:
 *  node equiv.mjs obs sp3 clk|- atx [systems] [hours] [gateK] */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { parseSp3 } from '../../src/rinex/sp3';
import { parseClk } from '../../src/rinex/clk';
import { parseAntex } from '../../src/antex';
import {
  solvePpp,
  buildPppAntenna,
  createPppCorrections,
} from '../../src/positioning';
import { solvePppUncombined } from '../../src/positioning/ppp-uncombined';
import { getEnuDifference } from '../../src/coordinates';
import { loadMulti, toDual, firstTwo } from './load';

const txt = (p: string) => {
  const b = readFileSync(p);
  return (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString(
    'latin1'
  );
};
const [
  obsP,
  sp3P,
  clkP,
  atxP,
  systems = 'GE',
  hours = '24',
  gate = '4',
  codeSig = '3',
] = process.argv.slice(2);
const t0 = Date.now();
const sp3 = parseSp3(txt(sp3P!));
const clk = clkP && clkP !== '-' ? parseClk(txt(clkP)) : undefined;
const antenna = buildPppAntenna(parseAntex(txt(atxP!)));
const { header, multi: all } = await loadMulti(obsP!, { systems });
const tEnd = all[0]!.timeMs + Number(hours) * 3600e3;
const multi = firstTwo(all.filter((e) => e.timeMs < tEnd));
console.log(
  'load',
  ((Date.now() - t0) / 1000).toFixed(1),
  's',
  multi.length,
  'epochs'
);
const apriori = header.approxPosition as [number, number, number];
const delta = header.antDelta ?? [0, 0, 0];
const corr = () =>
  createPppCorrections({
    antenna,
    rcvAntType: header.antType ?? '',
    antDeltaEnu: [delta[1], delta[2], delta[0]],
  });
const base = {
  aprioriPos: apriori,
  ...(clk ? { clk } : {}),
  estimateGradients: true,
};
let t = Date.now();
const ifs = solvePpp(toDual(multi), sp3, {
  ...base,
  corrections: corr(),
  slipRepair: false,
  codeSigma: Number(codeSig),
  ...(gate !== '4' ? { gateK: Number(gate) } : {}),
});
const tIf = (Date.now() - t) / 1000;
t = Date.now();
const k = (f1: number, f2: number) => {
  const g = (f1 * f1) / (f1 * f1 - f2 * f2);
  return 1 / Math.hypot(g, g - 1);
};
const scale: Record<string, { code: number; phase: number }> = {};
for (const [s, f1, f2] of [
  ['G', 1575.42e6, 1227.6e6],
  ['E', 1575.42e6, 1176.45e6],
  ['R', 1602e6, 1246e6],
  ['C', 1561.098e6, 1268.52e6],
] as const)
  scale[s] = { code: k(f1, f2), phase: k(f1, f2) };
const uc = solvePppUncombined(multi, sp3, {
  ...base,
  corrections: corr(),
  codeSigma: Number(codeSig),
  phaseSigma: 0.01,
  systemSigmaScale: scale,
  gateK: Number(gate),
});
const tUc = (Date.now() - t) / 1000;
const d = getEnuDifference(
  uc.position[0],
  uc.position[1],
  uc.position[2],
  ifs.position[0],
  ifs.position[1],
  ifs.position[2]
);
console.log(
  'IF  ',
  ifs.position.map((v) => v.toFixed(4)).join(' '),
  `${tIf.toFixed(1)} s`
);
console.log(
  'UC  ',
  uc.position.map((v) => v.toFixed(4)).join(' '),
  `${tUc.toFixed(1)} s, ${uc.nStates} states, ${uc.signalsWithoutSatAntenna} signals without sat antenna`
);
console.log('UC−IF ENU (mm)', d.map((v) => (v * 1000).toFixed(3)).join(' '));
for (let h = 1; h <= Number(hours); h *= 2) {
  const i =
    multi.findIndex((e) => e.timeMs >= multi[0]!.timeMs + h * 3600e3) - 1;
  const a = ifs.series[i];
  const b = uc.series[i];
  if (!a || !b) continue;
  const dd = getEnuDifference(
    b.position[0],
    b.position[1],
    b.position[2],
    a.position[0],
    a.position[1],
    a.position[2]
  );
  console.log(
    `${h} h: UC−IF ENU (mm)`,
    dd.map((v) => (v * 1000).toFixed(2)).join(' ')
  );
}
if (process.env.UC_DEBUG) {
  let prev = 0;
  for (let i = 0; i < multi.length; i++) {
    const a = ifs.series[i]!.position;
    const b = uc.series[i]!.position;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > 1e-5 && d > 3 * prev)
      console.log(
        'jump at epoch',
        i,
        new Date(multi[i]!.timeMs).toISOString(),
        (d * 1000).toFixed(4),
        'mm; sats',
        ifs.series[i]!.nSats,
        uc.series[i]!.nSats,
        multi[i]!.obs.map(
          (o) => o.prn + (o.signals.some((s) => s.lli) ? '*' : '')
        ).join(' ')
      );
    prev = Math.max(d, 1e-6);
    if (i % 30 === 0 || (i > 660 && i < 700))
      console.log(
        new Date(multi[i]!.timeMs).toISOString().slice(11, 19),
        (d * 1000).toFixed(4),
        ifs.series[i]!.nSats,
        uc.series[i]!.nSats,
        multi[i]!.obs.map((o) => o.prn).join(' ')
      );
  }
}
