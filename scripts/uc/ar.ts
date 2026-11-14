/**
 * PPP-AR time-to-fix on short windows: the ionosphere-free engine's AR
 * against the uncombined cascade (primary pair, all frequencies), the same
 * integer-clock products (SP3 + 30 s CLK + Bias-SINEX OSB).
 *
 *   node ar.mjs obs sp3 clk bia atx truthX,Y,Z systems windowH stepH [json]
 *
 * Prints one line per window and engine, then a summary.
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { parseSp3 } from '../../src/rinex/sp3';
import { parseClk } from '../../src/rinex/clk';
import { parseBiasSinex, SatOsbTable } from '../../src/rinex/bias-sinex';
import { parseAntex } from '../../src/antex';
import {
  solvePpp,
  buildPppAntenna,
  createPppCorrections,
  type PppEpochResult,
  type PppMultiEpoch,
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
const [
  obsP,
  sp3P,
  clkP,
  biaP,
  atxP,
  truthS,
  systems = 'GE',
  winH = '1',
  stepH = '3',
  extra,
] = process.argv.slice(2);
const truth = truthS!.split(',').map(Number) as [number, number, number];
const sp3 = parseSp3(txt(sp3P!));
const clk = parseClk(txt(clkP!));
const osb = new SatOsbTable(parseBiasSinex(txt(biaP!)));
const antenna = buildPppAntenna(parseAntex(txt(atxP!)));
const { header, multi: all } = await loadMulti(obsP!, { systems });
const delta = header.antDelta ?? [0, 0, 0];
const corr = () =>
  createPppCorrections({
    antenna,
    rcvAntType: header.antType ?? '',
    antDeltaEnu: [delta[1], delta[2], delta[0]],
  });
const ucExtra: Partial<PppUncombinedOptions> = extra ? JSON.parse(extra) : {};
const base = {
  aprioriPos: header.approxPosition as [number, number, number],
  clk,
  osb,
  estimateGradients: true,
};

interface Out {
  series: PppEpochResult[];
}
const engines: [string, (w: PppMultiEpoch[]) => Out][] = [
  [
    'IF-AR',
    (w) =>
      solvePpp(toDual(firstTwo(w)), sp3, {
        ...base,
        corrections: corr(),
        ar: true,
      }),
  ],
  [
    'IF-AR30',
    (w) =>
      solvePpp(toDual(firstTwo(w)), sp3, {
        ...base,
        corrections: corr(),
        ar: { everyS: 30, minArcS: 300 },
      }),
  ],
  [
    'UC2-AR',
    (w) =>
      solvePppUncombined(firstTwo(w), sp3, {
        ...base,
        corrections: corr(),
        ar: true,
        ...ucExtra,
      }),
  ],
  [
    'UCall-AR',
    (w) =>
      solvePppUncombined(w, sp3, {
        ...base,
        corrections: corr(),
        ar: true,
        ...ucExtra,
      }),
  ],
];

const err = (p: readonly number[]) =>
  getEnuDifference(p[0]!, p[1]!, p[2]!, truth[0], truth[1], truth[2]);
const t0 = all[0]!.timeMs;
const tEnd = all[all.length - 1]!.timeMs;
const summary = new Map<
  string,
  {
    ttf: number[];
    n: number;
    fixed: number;
    wrong: number;
    endErr: number[][];
    /** Float 3D error (mm) at 15, 30, 60 min, per window. */
    flt: number[][];
  }
>();
for (
  let ws = t0;
  ws + Number(winH) * 3600e3 <= tEnd + 30e3;
  ws += Number(stepH) * 3600e3
) {
  const w = all.filter(
    (e) => e.timeMs >= ws && e.timeMs < ws + Number(winH) * 3600e3
  );
  for (const [name, run] of engines) {
    const t = Date.now();
    const sol = run(w);
    const sec = (Date.now() - t) / 1000;
    // Time to the first fix within 5 cm of the truth; fixed epochs > 10 cm
    // off count as wrong.
    let ttf: number | null = null;
    let nFixed = 0;
    let wrong = 0;
    for (const r of sol.series) {
      if (!r.fixedPosition) continue;
      nFixed++;
      const d = Math.hypot(...err(r.fixedPosition));
      if (d > 0.1) wrong++;
      if (ttf === null && d < 0.05) ttf = (r.timeMs - w[0]!.timeMs) / 1000;
    }
    const last = sol.series[sol.series.length - 1]!;
    const endPos = last.fixedPosition ?? last.position;
    const e = err(endPos).map((v) => v * 1000);
    const s = summary.get(name) ?? {
      ttf: [],
      n: 0,
      fixed: 0,
      wrong: 0,
      endErr: [],
      flt: [],
    };
    s.n++;
    if (ttf !== null) s.ttf.push(ttf);
    if (last.fixedPosition) s.fixed++;
    s.wrong += wrong;
    s.endErr.push(e);
    s.flt.push(
      [15, 30, 60].map((m) => {
        const r =
          sol.series.find((q) => q.timeMs - w[0]!.timeMs >= m * 60e3) ?? last;
        return Math.hypot(...err(r.position)) * 1000;
      })
    );
    summary.set(name, s);
    console.log(
      new Date(ws).toISOString().slice(11, 16),
      name.padEnd(9),
      `ttf ${ttf === null ? '  —  ' : (ttf / 60).toFixed(1).padStart(5)} min`,
      `fixed ${((100 * nFixed) / sol.series.length).toFixed(0).padStart(3)} %`,
      `wrong ${wrong}`,
      `end ${last.fixedPosition ? 'fix' : 'flt'} ${e.map((v) => v.toFixed(1)).join('/')} mm`,
      `(${sec.toFixed(1)} s)`
    );
  }
}
console.log(
  '\nengine     windows  fixed-at-end  ttf median (min)  ttf ≤ window  wrong-epochs  end RMS E/N/U (mm)  float 3D median 15/30/60 min (mm)'
);
for (const [name, s] of summary) {
  const sorted = [...s.ttf].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! / 60 : NaN;
  const rms = [0, 1, 2].map((k) =>
    Math.sqrt(s.endErr.reduce((a, e) => a + e[k]! ** 2, 0) / s.endErr.length)
  );
  console.log(
    name.padEnd(10),
    String(s.n).padStart(7),
    String(s.fixed).padStart(13),
    med.toFixed(1).padStart(17),
    `${s.ttf.length}/${s.n}`.padStart(13),
    String(s.wrong).padStart(13),
    rms
      .map((v) => v.toFixed(1))
      .join('/')
      .padStart(20),
    [0, 1, 2]
      .map((k) => {
        const v = s.flt.map((f) => f[k]!).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)]!.toFixed(0);
      })
      .join('/')
      .padStart(22)
  );
}
