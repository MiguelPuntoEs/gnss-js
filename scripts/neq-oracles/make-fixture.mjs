// Builds test-fixtures/eur2297_neq_6sta.json: the 7 EUREF daily solutions of
// GPS week 2297 reduced (Schur complement — exact) to six stations, as SINEX
// NEQ text, plus the official EUR0 weekly coordinates of those stations.
// EUREF products: IAG/EUREF, freely available (epncb.oma.be / BKG).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as an from '../../dist/analysis.js';
import * as rinex from '../../dist/rinex.js';
import { DATA, readText, c2415 } from './common.mjs';
const SITES = ['WTZR', 'POTS', 'ONSA', 'ZIMM', 'GRAZ', 'JOZE'];
const dir = join(DATA, '2297');
const out = { sites: SITES, daily: [], weekly: {} };
for (let d = 0; d < 7; d++) {
  const f = rinex.parseSinex(
    readText(
      join(
        dir,
        `EUR0OPSSNX_2024${String(14 + d).padStart(3, '0')}0000_01D_01D_SOL.SNX`
      )
    )
  );
  const q = an.preEliminate(
    rinex.sinexToNeq(f),
    (p) => !SITES.includes(p.site)
  );
  out.daily.push(
    rinex.writeSinexNeq(q, {
      agency: 'EUR',
      description: 'EUREF daily combination, reduced to 6 stations',
      createdMs: Date.UTC(2026, 10, 13),
    })
  );
}
const w = rinex.parseSinex(
  readText(join(dir, 'EUR0OPSSNX_20240140000_07D_07D_SOL.SNX'))
);
for (const p of w.estimate)
  if (SITES.includes(p.site) && p.type.startsWith('STA')) {
    out.weekly[p.site] ??= { epochMs: p.refEpochMs, xyz: [0, 0, 0] };
    out.weekly[p.site].xyz['XYZ'.indexOf(p.type[3])] = p.value;
  }
const ssc = c2415();
for (const s of SITES)
  out.weekly[s].vel = ssc.filter((r) => r.site === s).at(-1).vel; // EPN C2415
writeFileSync('test-fixtures/eur2297_neq_6sta.json', JSON.stringify(out));
