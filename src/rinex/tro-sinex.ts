/**
 * Troposphere SINEX (SINEX_TRO): the format IGS, EUREF and E-GVAP exchange
 * zenith total delays and horizontal gradients in. Version 2.00 (IGS/EUREF
 * since 2022) is what `writeTroSinex` produces and what `parseTroSinex`
 * reads, together with the older 0.01/1.00 files (IGS final troposphere
 * until 2022), which differ in the epoch format (YY:DDD:SSSSS) and in
 * declaring the solution columns as `SOLUTION_FIELDS_1` (always mm).
 *
 * Version 2.00 layout (IGS Troposphere Working Group, SINEX_TRO v2.00):
 *
 *   %=TRO 2.00 AGC YYYY:DDD:SSSSS AGD YYYY:DDD:SSSSS YYYY:DDD:SSSSS P  MIX
 *   +FILE/REFERENCE         free-text producer information
 *   +TROP/DESCRIPTION       keyword/value pairs; TROPO PARAMETER NAMES /
 *                           UNITS / WIDTH declare the solution columns
 *   +SITE/ID, +SITE/RECEIVER, +SITE/ANTENNA, +SITE/COORDINATES,
 *   +SITE/ECCENTRICITY      station metadata (9-character ids)
 *   +TROP/SOLUTION          one row per station and epoch
 *   %=ENDTRO
 *
 * A column's UNITS factor converts metres to the file value (1e+03: mm), so
 * `value / unit` is metres; `troSeries` does that. Each STDDEV column
 * belongs to the parameter before it and is named `<PARAM>_STDDEV` here.
 */

/** Station metadata of a troposphere SINEX. */
export interface TroSite {
  /** 9-character id (e.g. "WTZR00DEU"); 4 characters in old files. */
  id: string;
  /** DOMES number, '' when unknown. */
  domes: string;
  description: string;
  /** Approximate geodetic position from SITE/ID (deg, deg, m), if given. */
  lonDeg?: number;
  latDeg?: number;
  heightM?: number;
  /** ECEF position (m) from SITE/COORDINATES or TROP/STA_COORDINATES. */
  xyz?: [number, number, number];
  /** Reference frame of `xyz`, e.g. "IGS20". */
  system?: string;
  receiver?: string;
  /** Antenna type and radome, RINEX's 16 + 4 characters. */
  antenna?: string;
  /** Antenna calibration model, e.g. "IGS20_2290". */
  pcvModel?: string;
  /** Antenna reference point above the marker: Up, North, East (m). */
  eccUne?: [number, number, number];
}

/** One TROP/SOLUTION row. */
export interface TroRecord {
  site: string;
  /** Epoch (ms on the file's time scale — GPS for IGS/EUREF). */
  epochMs: number;
  /** Values as written in the file, one per `TroSinex.fields` column;
   *  NaN where the column is blank or unparsable. */
  values: number[];
}

export interface TroSinex {
  /** '2.00', '1.00', '0.01'. */
  version: string;
  /** File agency, creation time, data agency, data span (ms). */
  agency: string;
  createdMs: number;
  dataAgency: string;
  startMs: number;
  endMs: number;
  /** FILE/REFERENCE lines by info type (DESCRIPTION, SOFTWARE, …). */
  reference: Record<string, string>;
  /** TROP/DESCRIPTION keyword → value (keywords upper case, trailing ':'
   *  dropped). */
  description: Record<string, string>;
  /** Solution columns, STDDEV columns as `<PARAM>_STDDEV`. */
  fields: string[];
  /** Per column: factor from metres to the file value (1000 = mm). */
  units: number[];
  sites: Map<string, TroSite>;
  records: TroRecord[];
}

const DAY_MS = 86_400_000;

/** "YYYY:DDD:SSSSS" or "YY:DDD:SSSSS" → ms; 0 for the all-zero epoch. */
function parseEpoch(s: string): number {
  const m = /^(\d{2}|\d{4}):(\d{3}):(\d{5})$/.exec(s.trim());
  if (!m) return NaN;
  let y = Number(m[1]);
  if (m[1]!.length === 2) y += y < 50 ? 2000 : 1900;
  const doy = Number(m[2]);
  if (doy === 0) return 0;
  return Date.UTC(y, 0, 1) + (doy - 1) * DAY_MS + Number(m[3]) * 1000;
}

/** "YYYY:DDD:SSSSS" (SINEX_TRO 2.00). */
export function troEpoch(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const doy = Math.floor((ms - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
  const sod = Math.round((ms - Date.UTC(y, 0, doy)) / 1000);
  return `${y}:${String(doy).padStart(3, '0')}:${String(sod).padStart(5, '0')}`;
}

/** What follows a row's DATA_START DATA_END pair (+ one space). Column
 *  positions before it differ between producers. */
function afterSpan(line: string): string {
  const m = /\d{2,4}:\d{3}:\d{5} +\d{2,4}:\d{3}:\d{5} /.exec(line);
  return m ? line.slice(m.index + m[0].length) : '';
}

/** Column names with every STDDEV renamed after the parameter before it. */
function nameFields(raw: string[]): string[] {
  const out: string[] = [];
  for (const f of raw) {
    const prev = out[out.length - 1];
    out.push(
      f === 'STDDEV' && prev ? `${prev.replace(/_STDDEV$/, '')}_STDDEV` : f
    );
  }
  return out;
}

/** Parse a troposphere SINEX file (2.00, 1.00 or 0.01). */
export function parseTroSinex(text: string): TroSinex {
  const lines = text.split(/\r?\n/);
  const head = (lines[0] ?? '').trim().split(/\s+/);
  if (!head[0]?.startsWith('%=TRO'))
    throw new Error('Not a troposphere SINEX file (no %=TRO header).');
  const tro: TroSinex = {
    version: head[1] ?? '',
    agency: head[2] ?? '',
    createdMs: parseEpoch(head[3] ?? ''),
    dataAgency: head[4] ?? '',
    startMs: parseEpoch(head[5] ?? ''),
    endMs: parseEpoch(head[6] ?? ''),
    reference: {},
    description: {},
    fields: [],
    units: [],
    sites: new Map(),
    records: [],
  };
  const site = (id: string): TroSite => {
    let s = tro.sites.get(id);
    if (!s) {
      s = { id, domes: '', description: '' };
      tro.sites.set(id, s);
    }
    return s;
  };
  let block = '';
  let lastComment = '';
  for (const line of lines.slice(1)) {
    if (line.startsWith('+')) {
      block = line.slice(1).trim();
      lastComment = '';
      continue;
    }
    if (line.startsWith('-') || line.startsWith('%')) {
      block = '';
      continue;
    }
    if (line.startsWith('*')) {
      lastComment = line;
      continue;
    }
    if (!block || !line.trim()) continue;
    const tok = line.trim().split(/\s+/);
    switch (block) {
      case 'FILE/REFERENCE':
        tro.reference[line.slice(1, 19).trim()] = line.slice(20).trim();
        break;
      case 'TROP/DESCRIPTION': {
        // 2.00: keyword in columns 2–30; 0.01: free spacing ("SAMPLING
        // TROP  300"). Split on the first run of 2+ spaces.
        const m = /^\s(\S.*?)(?:\s{2,}|\t)(.*)$/.exec(line);
        const key = (m ? m[1]! : line.trim())
          .replace(/:$/, '')
          .trim()
          .toUpperCase();
        tro.description[key] = (m ? m[2]! : '').trim();
        break;
      }
      case 'SITE/ID': {
        const s = site(tok[0]!);
        s.domes = line.slice(14, 23).trim();
        s.description = line.slice(26, 48).trim();
        const nums = line
          .slice(48)
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter(Number.isFinite);
        if (nums.length >= 3) {
          s.lonDeg = nums[0]! > 180 ? nums[0]! - 360 : nums[0]!;
          s.latDeg = nums[1]!;
          s.heightM = nums[2]!;
        }
        break;
      }
      case 'SITE/RECEIVER':
        site(tok[0]!).receiver = afterSpan(line).slice(0, 20).trim();
        break;
      case 'SITE/ANTENNA': {
        const s = site(tok[0]!);
        s.antenna = afterSpan(line).slice(0, 20).trimEnd();
        const pcv = tok[tok.length - 1]!;
        if (/_|IGS|EPN/.test(pcv)) s.pcvModel = pcv;
        break;
      }
      case 'SITE/COORDINATES':
      case 'TROP/STA_COORDINATES': {
        // Coordinates are the first three numbers with a decimal point
        // after the solution/epoch fields; the frame follows.
        const nums: number[] = [];
        let k = 1;
        for (; k < tok.length && nums.length < 3; k++)
          if (/^-?\d+\.\d+$/.test(tok[k]!) && Math.abs(+tok[k]!) > 1000)
            nums.push(+tok[k]!);
        if (nums.length === 3) {
          const s = site(tok[0]!);
          s.xyz = nums as [number, number, number];
          if (tok[k]) s.system = tok[k];
        }
        break;
      }
      case 'SITE/ECCENTRICITY': {
        const i = tok.indexOf('UNE');
        if (i > 0)
          site(tok[0]!).eccUne = [+tok[i + 1]!, +tok[i + 2]!, +tok[i + 3]!];
        break;
      }
      case 'TROP/SOLUTION': {
        if (!tro.fields.length) {
          // No TROPO PARAMETER NAMES: take the columns from the header
          // comment (0.01/1.00), in mm.
          const names = (
            tro.description['TROPO PARAMETER NAMES'] ??
            tro.description['TROPO PARAMETERS NAMES'] ??
            ''
          )
            .split(/\s+/)
            .filter(Boolean);
          const raw = names.length
            ? names
            : lastComment.slice(1).trim().split(/\s+/).slice(2);
          tro.fields = nameFields(raw);
          const units = (
            tro.description['TROPO PARAMETER UNITS'] ??
            tro.description['TROPO PARAMETERS UNITS'] ??
            ''
          )
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
          tro.units = tro.fields.map((_, i) =>
            Number.isFinite(units[i]) && units[i]! > 0 ? units[i]! : 1000
          );
        }
        tro.records.push({
          site: tok[0]!,
          epochMs: parseEpoch(tok[1]!),
          values: tro.fields.map((_, i) => {
            const v = tok[i + 2];
            return v === undefined ? NaN : Number(v);
          }),
        });
        break;
      }
      default:
        break;
    }
  }
  return tro;
}

/**
 * One station's values of one column, in metres (file value / unit), in
 * file order. `field` as in `TroSinex.fields`, e.g. 'TROTOT',
 * 'TROTOT_STDDEV', 'TGNTOT'. Sites match on their first 4 characters when
 * `site` has 4.
 */
export function troSeries(
  tro: TroSinex,
  site: string,
  field: string
): { tMs: number; value: number }[] {
  const i = tro.fields.indexOf(field);
  if (i < 0) return [];
  const unit = tro.units[i]!;
  const match =
    site.length === 4
      ? (s: string) => s.slice(0, 4).toUpperCase() === site.toUpperCase()
      : (s: string) => s.toUpperCase() === site.toUpperCase();
  return tro.records
    .filter((r) => match(r.site) && Number.isFinite(r.values[i]!))
    .map((r) => ({ tMs: r.epochMs, value: r.values[i]! / unit }));
}

/** A station's metadata for `writeTroSinex`. */
export interface TroSiteInput {
  /** 9-character id (4-character ids are padded "00XXX"). */
  id: string;
  domes?: string;
  description?: string;
  /** ECEF (m); the SITE/ID approximate position is derived from it. */
  xyz: readonly [number, number, number];
  /** Frame of `xyz`; default "IGS20". */
  system?: string;
  receiver?: string;
  /** RINEX antenna type + radome (16 + 4 characters). */
  antenna?: string;
  pcvModel?: string;
  /** ARP above the marker: Up, North, East (m). */
  eccUne?: readonly [number, number, number];
  /** Span of the data used (ms); default the file's span. */
  startMs?: number;
  endMs?: number;
}

/** One epoch of `writeTroSinex`'s solution: metres throughout. */
export interface TroEstimate {
  site: string;
  epochMs: number;
  ztd: number;
  ztdSigma?: number;
  /** North/east gradient (m) and their 1σ. */
  gradN?: number;
  gradNSigma?: number;
  gradE?: number;
  gradESigma?: number;
}

export interface TroSinexInput {
  /** 3-character agency code of the producer. */
  agency: string;
  /** Creation time (ms); default now. */
  createdMs?: number;
  /** FILE/REFERENCE fields (DESCRIPTION, OUTPUT, SOFTWARE, …). */
  reference?: Record<string, string>;
  /** TROP/DESCRIPTION keywords (TROPO SAMPLING INTERVAL, ELEVATION CUTOFF
   *  ANGLE, TROPO MAPPING FUNCTION, …); the parameter names/units/widths
   *  are written by the writer. */
  description?: Record<string, string>;
  sites: TroSiteInput[];
  estimates: TroEstimate[];
}

const DESC_ORDER = [
  'TROPO SAMPLING INTERVAL',
  'DATA SAMPLING INTERVAL',
  'GNSS SYSTEMS',
  'TIME SYSTEM',
  'TROPO MODELING METHOD',
  'OCEAN TIDE LOADING MODEL',
  'ELEVATION CUTOFF ANGLE',
  'OBSERVATION WEIGHTING',
  'A PRIORI TROPOSPHERE',
  'TROPO MAPPING FUNCTION',
  'GRADS MAPPING FUNCTION',
  'SOURCE OF MET/DATA',
];

/** Geodetic lat/lon (deg) and ellipsoidal height (m), GRS80. */
function geodetic(x: number, y: number, z: number): [number, number, number] {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
  }
  return [(lat * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI, h];
}

const id9 = (id: string) =>
  (id.length === 4 ? `${id}00XXX` : id).toUpperCase().slice(0, 9).padEnd(9);

/**
 * Write SINEX_TRO 2.00: TROTOT + STDDEV, and TGNTOT/TGETOT + STDDEV when any
 * estimate carries gradients — the columns and widths of the EUREF analysis
 * centres' files (mm, 1e+03). Blank cells would break column parsing, so
 * a missing σ or gradient is written as 0.
 */
export function writeTroSinex(input: TroSinexInput): string {
  const created = input.createdMs ?? Date.now();
  const est = [...input.estimates].sort(
    (a, b) => a.site.localeCompare(b.site) || a.epochMs - b.epochMs
  );
  const grads = est.some((e) => e.gradN != null && e.gradE != null);
  const t0 = est.length ? Math.min(...est.map((e) => e.epochMs)) : created;
  const t1 = est.length ? Math.max(...est.map((e) => e.epochMs)) : created;
  const ag = input.agency.toUpperCase().slice(0, 3).padEnd(3);
  const L: string[] = [];
  const rule =
    '*-------------------------------------------------------------------------------';
  L.push(
    `%=TRO 2.00 ${ag} ${troEpoch(created)} ${ag} ${troEpoch(t0)} ${troEpoch(t1)} P  MIX`
  );
  L.push(rule, '+FILE/REFERENCE');
  L.push(
    '*INFO_TYPE_________ INFO________________________________________________________'
  );
  for (const [k, v] of Object.entries(input.reference ?? {}))
    L.push(` ${k.toUpperCase().padEnd(18).slice(0, 18)} ${v.slice(0, 60)}`);
  L.push('-FILE/REFERENCE', rule, '+TROP/DESCRIPTION');
  L.push(
    '*_________KEYWORD_____________ __VALUE(S)______________________________'
  );
  const desc = { ...(input.description ?? {}) };
  const keys = [
    ...DESC_ORDER.filter((k) => k in desc),
    ...Object.keys(desc).filter((k) => !DESC_ORDER.includes(k)),
  ];
  for (const k of keys) L.push(` ${k.padEnd(29).slice(0, 29)} ${desc[k]}`);
  const names = grads
    ? ['TROTOT', 'STDDEV', 'TGNTOT', 'STDDEV', 'TGETOT', 'STDDEV']
    : ['TROTOT', 'STDDEV'];
  const widths = grads ? [6, 6, 7, 6, 7, 6] : [6, 6];
  const decimals = grads ? [1, 1, 3, 3, 3, 3] : [1, 1];
  const row = (cells: string[]) =>
    cells.map((c, i) => c.padStart(widths[i]!)).join(' ');
  L.push(` ${'TROPO PARAMETER NAMES'.padEnd(29)} ${row(names)}`);
  L.push(
    ` ${'TROPO PARAMETER UNITS'.padEnd(29)} ${row(names.map(() => '1e+03'))}`
  );
  L.push(` ${'TROPO PARAMETER WIDTH'.padEnd(29)} ${row(widths.map(String))}`);
  L.push('-TROP/DESCRIPTION', rule);

  const sites = [...input.sites].sort((a, b) =>
    id9(a.id).localeCompare(id9(b.id))
  );
  const span = (s: TroSiteInput) =>
    `${troEpoch(s.startMs ?? t0)} ${troEpoch(s.endMs ?? t1)}`;
  L.push('+SITE/ID');
  L.push(
    '*STATION__ PT __DOMES__ T _STATION_DESCRIPTION__ _LONGITUDE _LATITUDE_ _HGT_ELI_'
  );
  for (const s of sites) {
    const [lat, lon, h] = geodetic(s.xyz[0], s.xyz[1], s.xyz[2]);
    L.push(
      ` ${id9(s.id)}  A ${(s.domes ?? '').padEnd(9).slice(0, 9)} P ${(s.description ?? '').padEnd(22).slice(0, 22)} ${(((lon % 360) + 360) % 360).toFixed(6).padStart(10)} ${lat.toFixed(6).padStart(10)} ${h.toFixed(3).padStart(9)}`
    );
  }
  L.push('-SITE/ID');
  if (sites.some((s) => s.receiver)) {
    L.push('+SITE/RECEIVER');
    L.push(
      '*STATION__ PT SOLN T __DATA_START__ __DATA_END____ DESCRIPTION_________ S/N_________________ FIRMW______'
    );
    for (const s of sites)
      if (s.receiver)
        L.push(
          ` ${id9(s.id)}  A    1 P ${span(s)} ${s.receiver.padEnd(20).slice(0, 20)} ${'-----'.padStart(20)} -----------`
        );
    L.push('-SITE/RECEIVER');
  }
  if (sites.some((s) => s.antenna)) {
    L.push('+SITE/ANTENNA');
    L.push(
      '*STATION__ PT SOLN T __DATA_START__ __DATA_END____ DESCRIPTION_________ S/N_________________ PCV_MODEL_'
    );
    for (const s of sites)
      if (s.antenna)
        L.push(
          ` ${id9(s.id)}  A    1 P ${span(s)} ${s.antenna.padEnd(20).slice(0, 20)} ${'-----'.padStart(20)} ${(s.pcvModel ?? '').slice(0, 10)}`.trimEnd()
        );
    L.push('-SITE/ANTENNA');
  }
  L.push('+SITE/COORDINATES');
  L.push(
    '*STATION__ PT SOLN T __DATA_START__ __DATA_END____ __STA_X_____ __STA_Y_____ __STA_Z_____ SYSTEM REMRK'
  );
  for (const s of sites)
    L.push(
      ` ${id9(s.id)}  A    1 P ${span(s)} ${s.xyz.map((v) => v.toFixed(3).padStart(12)).join(' ')} ${(s.system ?? 'IGS20').padEnd(6).slice(0, 6)} ${ag}`
    );
  L.push('-SITE/COORDINATES');
  if (sites.some((s) => s.eccUne)) {
    L.push('+SITE/ECCENTRICITY');
    L.push(
      '*                                                      UP______ NORTH___ EAST____'
    );
    L.push(
      '*STATION__ PT SOLN T __DATA_START__ __DATA_END____ AXE ARP->BENCHMARK(M)_________'
    );
    for (const s of sites)
      if (s.eccUne)
        L.push(
          ` ${id9(s.id)}  A    1 P ${span(s)} UNE ${s.eccUne.map((v) => v.toFixed(4).padStart(8)).join(' ')}`
        );
    L.push('-SITE/ECCENTRICITY');
  }
  L.push(rule, '+TROP/SOLUTION');
  L.push(
    grads
      ? '*STATION__ _____EPOCH____ TROTOT STDDEV  TGNTOT STDDEV  TGETOT STDDEV'
      : '*STATION__ _____EPOCH____ TROTOT STDDEV'
  );
  const cell = (v: number | undefined, i: number) =>
    ((v ?? 0) * 1000).toFixed(decimals[i]!).padStart(widths[i]!);
  for (const e of est) {
    const vals = grads
      ? [e.ztd, e.ztdSigma, e.gradN, e.gradNSigma, e.gradE, e.gradESigma]
      : [e.ztd, e.ztdSigma];
    L.push(
      ` ${id9(e.site)} ${troEpoch(e.epochMs)} ${vals.map((v, i) => cell(v, i)).join(' ')}`
    );
  }
  L.push('-TROP/SOLUTION', '%=ENDTRO');
  return L.join('\n') + '\n';
}
