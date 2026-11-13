/**
 * IONEX writer: an {@link IonexGrid} as IONEX 1.0/1.1 text — header records
 * of Appendix A Table 1, TEC / RMS / height maps as Table 2 (mI5, 16 values
 * per line, 9999 = no value) and the DIFFERENTIAL CODE BIASES block of
 * Appendix B.
 *
 * Map values are written as round(value / 10^k) with k the map's own
 * EXPONENT (`mapExponents`) or the header one (default −1: 0.1 TECU).
 * Latitude rows and longitudes are written in the grid's order (`lats`,
 * `lons`); each row is labelled with the shell height HGT1. Header records
 * follow `headerOrder` when present, else Table 1's order; EPOCH OF
 * FIRST/LAST MAP and # OF MAPS IN FILE come from the maps written.
 *
 * Only 2-D maps: a MAP DIMENSION 3 grid is refused.
 */
import type { IonexGrid } from './ionex';

const L = (content: string, label: string) =>
  content.padEnd(60).slice(0, Math.max(60, content.length)) + label.padEnd(20);
const I = (v: number, w: number) => String(v).padStart(w);
const F = (v: number, w: number, d: number) => v.toFixed(d).padStart(w);

function epoch6(ms: number): string {
  const d = new Date(ms);
  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  ]
    .map((v) => I(v, 6))
    .join('');
}

/** Table 1 order. */
const ORDER = [
  'IONEX VERSION / TYPE',
  'PGM / RUN BY / DATE',
  'DESCRIPTION',
  'EPOCH OF FIRST MAP',
  'EPOCH OF LAST MAP',
  'INTERVAL',
  '# OF MAPS IN FILE',
  'MAPPING FUNCTION',
  'ELEVATION CUTOFF',
  'OBSERVABLES USED',
  '# OF STATIONS',
  '# OF SATELLITES',
  'BASE RADIUS',
  'MAP DIMENSION',
  'HGT1 / HGT2 / DHGT',
  'LAT1 / LAT2 / DLAT',
  'LON1 / LON2 / DLON',
  'EXPONENT',
  'COMMENT',
  'START OF AUX DATA',
  'END OF HEADER',
];

/** Write an IONEX file. */
export function writeIonex(g: IonexGrid): string {
  if ((g.mapDimension ?? 2) !== 2) {
    throw new Error('writeIonex: only 2-D maps (MAP DIMENSION 2)');
  }
  const exponent = g.exponent ?? -1;
  const hgt = g.hgt ?? { from: 450, to: 450, step: 0 };
  const nLat = g.lats.length;
  const nLon = g.lons.length;
  const latDef = g.latDef ?? {
    from: g.lats[0]!,
    to: g.lats[nLat - 1]!,
    step: nLat > 1 ? g.lats[1]! - g.lats[0]! : 0,
  };
  const lonDef = g.lonDef ?? {
    from: g.lons[0]!,
    to: g.lons[nLon - 1]!,
    step: nLon > 1 ? g.lons[1]! - g.lons[0]! : 0,
  };
  const grid = (d: { from: number; to: number; step: number }) =>
    '  ' + F(d.from, 6, 1) + F(d.to, 6, 1) + F(d.step, 6, 1);

  // Header lines per label, each list in its own order
  const H = new Map<string, string[]>();
  const add = (label: string, content: string) => {
    const a = H.get(label) ?? [];
    a.push(L(content, label));
    H.set(label, a);
  };
  add(
    'IONEX VERSION / TYPE',
    F(g.version ?? 1.0, 8, 1) +
      ' '.repeat(12) +
      'IONOSPHERE MAPS'.padEnd(20) +
      (g.system ?? 'GPS')
  );
  add(
    'PGM / RUN BY / DATE',
    (g.pgm ?? '').padEnd(20) + (g.runBy ?? '').padEnd(20) + (g.date ?? '')
  );
  for (const d of g.descriptions ?? []) add('DESCRIPTION', d);
  if (g.epochs.length) {
    add('EPOCH OF FIRST MAP', epoch6(g.epochs[0]!));
    add('EPOCH OF LAST MAP', epoch6(g.epochs[g.epochs.length - 1]!));
  }
  const interval =
    g.interval ??
    (g.epochs.length > 1
      ? Math.round((g.epochs[1]! - g.epochs[0]!) / 1000)
      : 0);
  add('INTERVAL', I(interval, 6));
  add('# OF MAPS IN FILE', I(g.maps.length, 6));
  add('MAPPING FUNCTION', '  ' + (g.mappingFunction ?? 'NONE'));
  add('ELEVATION CUTOFF', F(g.elevationCutoff ?? 0, 8, 1));
  add('OBSERVABLES USED', g.observablesUsed ?? '');
  if (g.numStations !== undefined) add('# OF STATIONS', I(g.numStations, 6));
  if (g.numSatellites !== undefined)
    add('# OF SATELLITES', I(g.numSatellites, 6));
  add('BASE RADIUS', F(g.baseRadius ?? 6371, 8, 1));
  add('MAP DIMENSION', I(2, 6));
  add('HGT1 / HGT2 / DHGT', grid(hgt));
  add('LAT1 / LAT2 / DLAT', grid(latDef));
  add('LON1 / LON2 / DLON', grid(lonDef));
  add('EXPONENT', I(exponent, 6));
  for (const c of g.comments ?? []) add('COMMENT', c);
  if (g.aux) {
    const a = g.aux;
    const sats = a.sats.map((s) =>
      L(
        '   ' + s.prn.padEnd(3) + F(s.biasNs, 10, 3) + F(s.rmsNs, 10, 3),
        'PRN / BIAS / RMS'
      )
    );
    // 1X,A3,2X,A4,1X,A15,2F10.3 — as IGS analysis centres write it
    const stations = a.stations.map((s) =>
      L(
        ' ' +
          s.sys.padEnd(3) +
          '  ' +
          s.name.padEnd(4) +
          ' ' +
          s.id.padEnd(15) +
          F(s.biasNs, 10, 3) +
          F(s.rmsNs, 10, 3),
        'STATION / BIAS / RMS'
      )
    );
    H.set('START OF AUX DATA', [
      [
        L(a.name, 'START OF AUX DATA'),
        ...(a.stationsFirst ? [...stations, ...sats] : [...sats, ...stations]),
        ...a.comments.map((c) => L(c, 'COMMENT')),
        L(a.name, 'END OF AUX DATA'),
      ].join('\n'),
    ]);
  }
  add('END OF HEADER', '');

  const order = g.headerOrder?.length ? g.headerOrder : ORDER;
  const out: { label: string; line: string }[] = [];
  for (const label of order) {
    if (label === 'END OF AUX DATA') continue;
    const a = H.get(label);
    if (!a?.length) continue;
    // Table 1 order emits a label's lines together; a file order one by one
    const take = order === ORDER ? a.splice(0) : a.splice(0, 1);
    for (const line of take) out.push({ label, line });
  }
  for (const [label, rest] of H)
    for (const line of rest) {
      let at = out.map((o) => o.label).lastIndexOf(label);
      if (at < 0) at = out.findIndex((o) => o.label === 'END OF HEADER') - 1;
      if (at < 0) at = out.length - 1;
      out.splice(at + 1, 0, { label, line });
    }
  if (!out.some((o) => o.label === 'END OF HEADER'))
    out.push({ label: 'END OF HEADER', line: L('', 'END OF HEADER') });
  const text = out.map((o) => o.line);

  // Map blocks
  const block = (
    kind: 'TEC' | 'RMS' | 'HEIGHT',
    n: number,
    map: Float32Array,
    exp: number | null | undefined,
    epochMs: number | undefined
  ) => {
    text.push(L(I(n, 6), `START OF ${kind} MAP`));
    if (epochMs !== undefined)
      text.push(L(epoch6(epochMs), 'EPOCH OF CURRENT MAP'));
    if (exp != null) text.push(L(I(exp, 6), 'EXPONENT'));
    const unit = Math.pow(10, exp ?? exponent);
    for (let li = 0; li < nLat; li++) {
      text.push(
        L(
          '  ' +
            F(g.lats[li]!, 6, 1) +
            F(lonDef.from, 6, 1) +
            F(lonDef.to, 6, 1) +
            F(lonDef.step, 6, 1) +
            F(hgt.from, 6, 1),
          'LAT/LON1/LON2/DLON/H'
        )
      );
      for (let k = 0; k < nLon; k += 16) {
        let row = '';
        for (let j = k; j < Math.min(k + 16, nLon); j++) {
          const v = map[li * nLon + j]!;
          row += I(Number.isFinite(v) ? Math.round(v / unit) : 9999, 5);
        }
        text.push(row.padEnd(80));
      }
    }
    text.push(L(I(n, 6), `END OF ${kind} MAP`));
  };
  g.maps.forEach((m, k) =>
    block('TEC', k + 1, m, g.mapExponents?.[k], g.epochs[k])
  );
  g.rmsMaps?.forEach((m, k) =>
    block(
      'RMS',
      k + 1,
      m,
      g.rmsExponents?.[k],
      g.rmsHasEpoch?.[k] === false ? undefined : g.epochs[k]
    )
  );
  g.heightMaps?.forEach((m, k) =>
    block(
      'HEIGHT',
      k + 1,
      m,
      g.heightExponents?.[k],
      g.heightHasEpoch?.[k] === false ? undefined : g.epochs[k]
    )
  );
  text.push(L('', 'END OF FILE'));
  return text.join('\n') + '\n';
}
