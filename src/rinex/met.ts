/**
 * RINEX meteorological data files (`*.yyM`, `*_MM.rnx`) — reader and writer
 * for versions 2.11 (Tables A5/A6/A9), 3.0x (A19–A22) and 4.0x (A42–A44).
 *
 * Header: RINEX VERSION / TYPE (F9.2,11X,"METEOROLOGICAL DATA"), MARKER
 * NAME (A60), MARKER NUMBER (A20), # / TYPES OF OBSERV (I6,9(4X,A2), then
 * 6X,9(4X,A2) continuation lines), SENSOR MOD/TYPE/ACC (A20,A20,6X,F7.1,
 * 4X,A2,1X) and SENSOR POS XYZ/H (3F14.4,1F14.4,1X,A2,1X) per observation
 * type, END OF HEADER.
 *
 * Data record: epoch in GPS time (not local time) — 1X,I2.2 two-digit year
 * (80–99 → 19xx, 00–79 → 20xx) in 2.xx, 1X,I4.4 in 3.xx/4.xx — then
 * 5(1X,I2) month … second, then mF7.1 values in the header's type order,
 * more than 8 on 4X,10F7.1 continuation lines.
 *
 * Units, as the specifications define them: PR pressure mbar (= hPa), TD
 * dry temperature °C, HR relative humidity %, ZW/ZD/ZT zenith path delays
 * mm, WD wind azimuth ° (from where the wind blows), WS wind speed m/s,
 * RI rain increment 1/10 mm, HI hail indicator. Values are kept in these
 * file units — no conversion.
 *
 * Epochs are GPS-scale ms (Date.UTC of the calendar fields, no leap
 * seconds applied), like the observation parsers.
 */

export interface MetSensor {
  /** Model (manufacturer), type, accuracy (obs units; absent if blank). */
  model: string;
  type: string;
  accuracy?: number;
  /** Observation type the sensor measures ('PR', 'TD', …). */
  obs: string;
}

export interface MetSensorPosition {
  /** Geocentric X, Y, Z (m; zeros when unknown) and ellipsoidal height. */
  x: number;
  y: number;
  z: number;
  h: number;
  obs: string;
}

export interface MetRecord {
  /** Epoch, GPS-scale ms. */
  timeMs: number;
  /** Values by observation type, in file units; NaN when blank. */
  values: Record<string, number>;
}

export interface RinexMet {
  version: number;
  markerName: string;
  markerNumber?: string;
  /** Observation types in record order. */
  types: string[];
  sensors: MetSensor[];
  positions: MetSensorPosition[];
  /** COMMENT texts (columns 1–60), in order. */
  comments: string[];
  records: MetRecord[];
  /** The header as read: each line's label and whole text, so a writer
   *  keeps the order and the lines it does not model (PGM / RUN BY /
   *  DATE, COMMENT). */
  headerLines?: { label: string; line: string }[];
  /** Epoch fields written zero-padded ("00 00 05", gfzrnx style) rather
   *  than blank-padded (" 0  0  5", the 5(1X,I2) of the specification). */
  zeroPadEpoch?: boolean;
}

const LABELS = [
  'RINEX VERSION / TYPE',
  'PGM / RUN BY / DATE',
  'COMMENT',
  'MARKER NAME',
  'MARKER NUMBER',
  '# / TYPES OF OBSERV',
  'SENSOR MOD/TYPE/ACC',
  'SENSOR POS XYZ/H',
  'END OF HEADER',
];

/** The header label of a line: columns 61–80, or a known label the line
 *  ends with (a multi-byte character in columns 1–60 shifts it). */
function labelOf(line: string): string {
  const l = line.slice(60).trim();
  if (LABELS.includes(l)) return l;
  const t = line.trimEnd();
  return LABELS.find((x) => t.endsWith(x)) ?? l;
}

const blankNum = (s: string): number | undefined =>
  s.trim() === '' ? undefined : Number(s);

/** Parse a RINEX 2.11 / 3.0x / 4.0x meteorological file. */
export function parseRinexMet(text: string): RinexMet {
  const lines = text.split(/\r?\n/);
  const met: RinexMet = {
    version: 0,
    markerName: '',
    types: [],
    sensors: [],
    positions: [],
    comments: [],
    records: [],
    headerLines: [],
  };
  let nTypes = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    const label = labelOf(line);
    met.headerLines!.push({ label, line });
    const c =
      line.slice(60).trim() === label || !label
        ? line.slice(0, 60)
        : line.slice(0, line.length - label.length);
    switch (label) {
      case 'RINEX VERSION / TYPE':
        met.version = Number(c.slice(0, 9));
        break;
      case 'COMMENT':
        met.comments.push(c.trimEnd());
        break;
      case 'MARKER NAME':
        met.markerName = c.trim();
        break;
      case 'MARKER NUMBER':
        met.markerNumber = c.slice(0, 20).trim();
        break;
      case '# / TYPES OF OBSERV':
        if (!met.types.length) nTypes = Number(c.slice(0, 6));
        for (let k = 0; k < 9 && met.types.length < nTypes; k++)
          met.types.push(c.slice(10 + 6 * k, 12 + 6 * k).trim());
        break;
      case 'SENSOR MOD/TYPE/ACC': {
        const s: MetSensor = {
          model: c.slice(0, 20).trim(),
          type: c.slice(20, 40).trim(),
          obs: c.slice(57, 59).trim(),
        };
        const acc = blankNum(c.slice(46, 53));
        if (acc !== undefined) s.accuracy = acc;
        met.sensors.push(s);
        break;
      }
      case 'SENSOR POS XYZ/H':
        met.positions.push({
          x: Number(c.slice(0, 14)) || 0,
          y: Number(c.slice(14, 28)) || 0,
          z: Number(c.slice(28, 42)) || 0,
          h: Number(c.slice(42, 56)) || 0,
          obs: c.slice(57, 59).trim(),
        });
        break;
    }
    if (label === 'END OF HEADER') {
      i++;
      break;
    }
  }
  const v2 = met.version < 3;
  const epochLen = v2 ? 18 : 20;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const e = line.slice(0, epochLen).trim().split(/\s+/).map(Number);
    if (e.length !== 6 || e.some((x) => !Number.isInteger(x))) continue;
    let y = e[0]!;
    if (v2) y += y < 80 ? 2000 : 1900;
    if (met.records.length === 0)
      met.zeroPadEpoch = /^ \d+ \d\d \d\d \d\d \d\d \d\d/.test(line);
    const vals: string[] = [];
    let rest = line.slice(epochLen);
    for (let k = 0; k < met.types.length; k++) {
      // 8 values on the epoch line, then 10 per 4X continuation line.
      if (k > 0 && (k === 8 || (k > 8 && (k - 8) % 10 === 0)))
        rest = (lines[++i] ?? '').slice(4);
      const at = k < 8 ? k : (k - 8) % 10;
      vals.push(rest.slice(at * 7, at * 7 + 7));
    }
    const values: Record<string, number> = {};
    met.types.forEach((t, k) => {
      const v = blankNum(vals[k]!);
      values[t] = v === undefined ? NaN : v;
    });
    met.records.push({
      timeMs: Date.UTC(y, e[1]! - 1, e[2]!, e[3]!, e[4]!, e[5]!),
      values,
    });
  }
  return met;
}

/* ── Writer ──────────────────────────────────────────────────────── */

const L = (content: string, label: string) =>
  content.padEnd(60).slice(0, 60) + label;

/** Fortran Fw.d; keeps a −0 as "-0.0". */
const F = (v: number, w: number, d: number) =>
  (Object.is(v, -0) ? '-' + (0).toFixed(d) : v.toFixed(d)).padStart(w);

function typesLines(types: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < Math.max(1, types.length); k += 9) {
    const head = k === 0 ? String(types.length).padStart(6) : ' '.repeat(6);
    out.push(
      L(
        head +
          types
            .slice(k, k + 9)
            .map((t) => '    ' + t.padEnd(2))
            .join(''),
        '# / TYPES OF OBSERV'
      )
    );
  }
  return out;
}

const sensorLine = (s: MetSensor) =>
  L(
    s.model.padEnd(20).slice(0, 20) +
      s.type.padEnd(20).slice(0, 20) +
      ' '.repeat(6) +
      (s.accuracy != null ? F(s.accuracy, 7, 1) : ' '.repeat(7)) +
      ' '.repeat(4) +
      s.obs.padEnd(2) +
      ' ',
    'SENSOR MOD/TYPE/ACC'
  );

const posLine = (p: MetSensorPosition) =>
  L(
    F(p.x, 14, 4) +
      F(p.y, 14, 4) +
      F(p.z, 14, 4) +
      F(p.h, 14, 4) +
      ' ' +
      p.obs.padEnd(2) +
      ' ',
    'SENSOR POS XYZ/H'
  );

const two = (n: number, zero: boolean) =>
  zero ? String(n).padStart(2, '0') : String(n).padStart(2);

/**
 * Write a {@link RinexMet} as RINEX meteorological text, in its `version`
 * (2.xx: two-digit years; 3.xx/4.xx: four). A parsed file keeps its header
 * order and the lines not modelled (PGM / RUN BY / DATE, COMMENT,
 * unknown labels) verbatim; the modelled ones are re-formatted from the
 * fields.
 */
export function writeRinexMet(met: RinexMet): string {
  const modelled = (label: string): string[] => {
    switch (label) {
      case 'RINEX VERSION / TYPE':
        return [
          L(
            F(met.version, 9, 2) + ' '.repeat(11) + 'METEOROLOGICAL DATA',
            label
          ),
        ];
      case 'MARKER NAME':
        return [L(met.markerName, label)];
      case 'MARKER NUMBER':
        return met.markerNumber != null ? [L(met.markerNumber, label)] : [];
      case '# / TYPES OF OBSERV':
        return typesLines(met.types);
      case 'END OF HEADER':
        return [L('', label)];
    }
    return [];
  };
  const out: string[] = [];
  if (met.headerLines?.length) {
    let sensor = 0;
    let pos = 0;
    let typesDone = false;
    for (const { label, line } of met.headerLines) {
      if (label === 'SENSOR MOD/TYPE/ACC') {
        const s = met.sensors[sensor++];
        if (s) out.push(sensorLine(s));
      } else if (label === 'SENSOR POS XYZ/H') {
        const p = met.positions[pos++];
        if (p) out.push(posLine(p));
      } else if (label === '# / TYPES OF OBSERV') {
        if (!typesDone) out.push(...modelled(label));
        typesDone = true;
      } else if (
        label === 'COMMENT' ||
        label === 'PGM / RUN BY / DATE' ||
        !LABELS.includes(label)
      )
        out.push(line);
      else out.push(...modelled(label));
    }
    // Sensors / positions added after parsing go before END OF HEADER.
    const extra = [
      ...met.sensors.slice(sensor).map(sensorLine),
      ...met.positions.slice(pos).map(posLine),
    ];
    if (extra.length) out.splice(out.length - 1, 0, ...extra);
  } else {
    out.push(...modelled('RINEX VERSION / TYPE'));
    for (const c of met.comments) out.push(L(c, 'COMMENT'));
    out.push(...modelled('MARKER NAME'), ...modelled('MARKER NUMBER'));
    out.push(...modelled('# / TYPES OF OBSERV'));
    out.push(...met.sensors.map(sensorLine), ...met.positions.map(posLine));
    out.push(...modelled('END OF HEADER'));
  }

  const v2 = met.version < 3;
  const z = !!met.zeroPadEpoch;
  for (const r of met.records) {
    const d = new Date(r.timeMs);
    const y = d.getUTCFullYear();
    let line =
      ' ' +
      (v2 ? String(y % 100).padStart(2, '0') : String(y).padStart(4, '0')) +
      [
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
      ]
        .map((n) => ' ' + two(n, z))
        .join('');
    met.types.forEach((t, k) => {
      if (k === 8 || (k > 8 && (k - 8) % 10 === 0)) {
        out.push(line.trimEnd());
        line = '    ';
      }
      const v = r.values[t];
      line += v == null || Number.isNaN(v) ? ' '.repeat(7) : F(v, 7, 1);
    });
    out.push(line.trimEnd());
  }
  return out.join('\n') + '\n';
}
