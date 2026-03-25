/**
 * NTRIP client library — supports both NTRIP 1.0 and 2.0 protocols.
 *
 * NTRIP (Networked Transport of RTCM via Internet Protocol) streams GNSS
 * correction data from a caster to clients over HTTP.
 *
 * Protocol differences:
 *  - NTRIP 1.0: ICY-style responses, no chunked encoding, User-Agent starts with "NTRIP"
 *  - NTRIP 2.0: Standard HTTP/1.1, chunked transfer encoding, Ntrip-Version header
 *
 * Since browsers can't connect directly to NTRIP casters (CORS), all requests
 * are proxied through a lightweight endpoint (e.g. Cloudflare Worker).
 */

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

export type NtripVersion = '1.0' | '2.0';

/** A STR (stream) entry from the sourcetable. */
export interface NtripStream {
  type: 'STR';
  mountpoint: string;
  identifier: string;
  format: string;
  formatDetails: string;
  carrier: number;
  navSystem: string;
  network: string;
  country: string;
  latitude: number;
  longitude: number;
  nmea: number;
  solution: number;
  generator: string;
  compression: string;
  authentication: string;
  fee: string;
  bitrate: number;
  misc: string;
}

/** A CAS (caster) entry from the sourcetable. */
export interface NtripCaster {
  type: 'CAS';
  host: string;
  port: number;
  identifier: string;
  operator: string;
  nmea: number;
  country: string;
  latitude: number;
  longitude: number;
  fallbackHost: string;
  fallbackPort: number;
  misc: string;
}

/** A NET (network) entry from the sourcetable. */
export interface NtripNetwork {
  type: 'NET';
  identifier: string;
  operator: string;
  authentication: string;
  fee: string;
  webUrl: string;
  streamUrl: string;
  registrationUrl: string;
  misc: string;
}

export type SourcetableEntry = NtripStream | NtripCaster | NtripNetwork;

export interface Sourcetable {
  streams: NtripStream[];
  casters: NtripCaster[];
  networks: NtripNetwork[];
  raw: string;
}

export interface NtripConnectionInfo {
  host: string;
  port: number;
  mountpoint?: string;
  username?: string;
  password?: string;
  version: NtripVersion;
}

/* ================================================================== */
/*  Sourcetable parser                                                 */
/* ================================================================== */

function parseStreamEntry(fields: string[]): NtripStream | null {
  if (fields.length < 19) return null;
  return {
    type: 'STR',
    mountpoint: fields[1] ?? '',
    identifier: fields[2] ?? '',
    format: fields[3] ?? '',
    formatDetails: fields[4] ?? '',
    carrier: parseInt(fields[5] ?? '0') || 0,
    navSystem: fields[6] ?? '',
    network: fields[7] ?? '',
    country: fields[8] ?? '',
    latitude: parseFloat(fields[9] ?? '0') || 0,
    longitude: parseFloat(fields[10] ?? '0') || 0,
    nmea: parseInt(fields[11] ?? '0') || 0,
    solution: parseInt(fields[12] ?? '0') || 0,
    generator: fields[13] ?? '',
    compression: fields[14] ?? '',
    authentication: fields[15] ?? 'N',
    fee: fields[16] ?? 'N',
    bitrate: parseInt(fields[17] ?? '0') || 0,
    misc: fields[18] ?? '',
  };
}

function parseCasterEntry(fields: string[]): NtripCaster | null {
  if (fields.length < 12) return null;
  return {
    type: 'CAS',
    host: fields[1] ?? '',
    port: parseInt(fields[2] ?? '0') || 0,
    identifier: fields[3] ?? '',
    operator: fields[4] ?? '',
    nmea: parseInt(fields[5] ?? '0') || 0,
    country: fields[6] ?? '',
    latitude: parseFloat(fields[7] ?? '0') || 0,
    longitude: parseFloat(fields[8] ?? '0') || 0,
    fallbackHost: fields[9] ?? '',
    fallbackPort: parseInt(fields[10] ?? '0') || 0,
    misc: fields[11] ?? '',
  };
}

function parseNetworkEntry(fields: string[]): NtripNetwork | null {
  if (fields.length < 9) return null;
  return {
    type: 'NET',
    identifier: fields[1] ?? '',
    operator: fields[2] ?? '',
    authentication: fields[3] ?? '',
    fee: fields[4] ?? '',
    webUrl: fields[5] ?? '',
    streamUrl: fields[6] ?? '',
    registrationUrl: fields[7] ?? '',
    misc: fields[8] ?? '',
  };
}

/** Parse the full sourcetable text returned by a caster. */
export function parseSourcetable(text: string): Sourcetable {
  const streams: NtripStream[] = [];
  const casters: NtripCaster[] = [];
  const networks: NtripNetwork[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'ENDSOURCETABLE') continue;

    const fields = line.split(';');
    const entryType = fields[0]?.toUpperCase();

    if (entryType === 'STR') {
      const entry = parseStreamEntry(fields);
      if (entry) streams.push(entry);
    } else if (entryType === 'CAS') {
      const entry = parseCasterEntry(fields);
      if (entry) casters.push(entry);
    } else if (entryType === 'NET') {
      const entry = parseNetworkEntry(fields);
      if (entry) networks.push(entry);
    }
  }

  return { streams, casters, networks, raw: text };
}

/* ================================================================== */
/*  NTRIP fetch helpers                                                */
/* ================================================================== */

function buildAuthHeader(username?: string, password?: string): string | null {
  if (!username) return null;
  return 'Basic ' + btoa(`${username}:${password ?? ''}`);
}

function ntripHeaders(info: NtripConnectionInfo): Record<string, string> {
  const headers: Record<string, string> = {
    'Ntrip-Version': info.version === '2.0' ? 'Ntrip/2.0' : 'Ntrip/1.0',
    'User-Agent': 'NTRIP gnss-js/1.0',
    'X-Ntrip-Host': info.host,
    'X-Ntrip-Port': String(info.port),
  };
  const auth = buildAuthHeader(info.username, info.password);
  if (auth) headers['Authorization'] = auth;
  return headers;
}

async function ntripFetch(
  proxyUrl: string,
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<Response> {
  const url = `${proxyUrl}${path}`;
  try {
    return await fetch(url, { headers, signal });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const message =
      err instanceof Error
        ? err.message
        : 'The service may be temporarily unavailable.';
    throw new Error(`Could not reach the NTRIP proxy: ${message}`, {
      cause: err,
    });
  }
}

/**
 * Fetch the sourcetable from an NTRIP caster.
 * @param proxyUrl Base URL of the CORS proxy (e.g. "https://ntrip-proxy.example.com")
 */
export async function fetchSourcetable(
  proxyUrl: string,
  info: NtripConnectionInfo,
  signal?: AbortSignal
): Promise<Sourcetable> {
  const headers = ntripHeaders(info);
  const res = await ntripFetch(proxyUrl, '/', headers, signal);

  if (res.status === 401) {
    throw new Error(
      'Authentication required. Please provide valid credentials.'
    );
  }
  if (!res.ok) {
    throw new Error(`Caster returned ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  return parseSourcetable(text);
}

/* ================================================================== */
/*  Stream connection                                                  */
/* ================================================================== */

export interface NtripStreamConnection {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: () => void;
}

/**
 * Connect to an NTRIP mountpoint and return a stream reader.
 * @param proxyUrl Base URL of the CORS proxy
 */
export async function connectToMountpoint(
  proxyUrl: string,
  info: NtripConnectionInfo & { mountpoint: string },
  signal?: AbortSignal
): Promise<NtripStreamConnection> {
  const headers = ntripHeaders(info);

  const controller = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  const res = await ntripFetch(
    proxyUrl,
    `/${info.mountpoint}`,
    headers,
    combinedSignal
  );

  if (res.status === 401) {
    throw new Error('Authentication required for this mountpoint.');
  }
  if (res.status === 404) {
    throw new Error(`Mountpoint "/${info.mountpoint}" not found on caster.`);
  }
  if (!res.ok) {
    throw new Error(`Caster returned ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(
      'No response body — streaming not supported by this environment.'
    );
  }

  return {
    reader: res.body.getReader(),
    abort: () => controller.abort(),
  };
}
