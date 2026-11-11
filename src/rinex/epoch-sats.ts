/**
 * One epoch's observation values in a single block.
 *
 * A `Map<string, Float64Array>` per epoch costs one typed array (plus its
 * buffer) per satellite: on a 1 Hz day (3.5 M satellite-epochs) that
 * bookkeeping was ~1 GB on top of ~0.5 GB of values. `EpochSats` keeps
 * the PRNs and their slots in two small arrays and every value in one
 * `Float64Array`, halving the memory with the same Map-like interface.
 *
 * Semantics differ from a Map in one way: `set` copies the values in, and
 * `get` returns a view of the block — writes through it land in the
 * epoch, but only until the next `set` that adds a satellite or widens a
 * slot (the block may move). Fill a row first, then `set` it.
 */

/** What readers and writers of compact epochs need; a Map satisfies it. */
export interface SatValues {
  readonly size: number;
  get(prn: string): Float64Array | undefined;
  has(prn: string): boolean;
  set(prn: string, values: Float64Array): unknown;
  delete(prn: string): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<Float64Array>;
  entries(): IterableIterator<[string, Float64Array]>;
  [Symbol.iterator](): IterableIterator<[string, Float64Array]>;
}

export class EpochSats implements SatValues {
  private prns: string[] = [];
  private start: number[] = [];
  private len: number[] = [];
  private vals: Float64Array;
  private used = 0;

  /** `capacity`: expected values in the epoch (grows as needed). */
  constructor(capacity = 0) {
    this.vals = new Float64Array(capacity);
  }

  get size(): number {
    return this.prns.length;
  }

  has(prn: string): boolean {
    return this.prns.includes(prn);
  }

  get(prn: string): Float64Array | undefined {
    const i = this.prns.indexOf(prn);
    if (i < 0) return undefined;
    const s = this.start[i]!;
    return this.vals.subarray(s, s + this.len[i]!);
  }

  set(prn: string, values: Float64Array): this {
    const i = this.prns.indexOf(prn);
    if (i >= 0 && values.length <= this.len[i]!) {
      // Same or narrower: overwrite in place, NaN-padding the rest.
      const s = this.start[i]!;
      this.vals.set(values, s);
      this.vals.fill(NaN, s + values.length, s + this.len[i]!);
      this.len[i] = values.length;
      return this;
    }
    // New satellite, or a wider row (codes added): a new slot at the end.
    // A widened satellite's old slot is left unused until `compact`.
    const s = this.reserve(values.length);
    this.vals.set(values, s);
    if (i >= 0) {
      this.start[i] = s;
      this.len[i] = values.length;
    } else {
      this.prns.push(prn);
      this.start.push(s);
      this.len.push(values.length);
    }
    return this;
  }

  delete(prn: string): boolean {
    const i = this.prns.indexOf(prn);
    if (i < 0) return false;
    this.prns.splice(i, 1);
    this.start.splice(i, 1);
    this.len.splice(i, 1);
    return true;
  }

  *keys(): IterableIterator<string> {
    yield* this.prns;
  }

  *values(): IterableIterator<Float64Array> {
    for (let i = 0; i < this.prns.length; i++)
      yield this.vals.subarray(this.start[i]!, this.start[i]! + this.len[i]!);
  }

  *entries(): IterableIterator<[string, Float64Array]> {
    for (let i = 0; i < this.prns.length; i++)
      yield [
        this.prns[i]!,
        this.vals.subarray(this.start[i]!, this.start[i]! + this.len[i]!),
      ];
  }

  [Symbol.iterator](): IterableIterator<[string, Float64Array]> {
    return this.entries();
  }

  /**
   * Drop spare capacity and slots left by widened or deleted satellites.
   * Call once an epoch is complete; views from `get` are stale after.
   */
  compact(): this {
    let n = 0;
    for (const l of this.len) n += l;
    if (n === this.vals.length && n === this.used) return this;
    const out = new Float64Array(n);
    let o = 0;
    for (let i = 0; i < this.prns.length; i++) {
      const s = this.start[i]!;
      out.set(this.vals.subarray(s, s + this.len[i]!), o);
      this.start[i] = o;
      o += this.len[i]!;
    }
    this.vals = out;
    this.used = n;
    return this;
  }

  /** `n` more values at the end, growing the block by half when full. */
  private reserve(n: number): number {
    const s = this.used;
    if (s + n > this.vals.length) {
      const grown = new Float64Array(
        Math.max(s + n, Math.ceil(this.vals.length * 1.5), 64)
      );
      grown.set(this.vals.subarray(0, s));
      this.vals = grown;
    }
    this.used = s + n;
    return s;
  }
}

/** Compact a finished epoch's values if they live in an {@link EpochSats}. */
export function compactEpochSats(sats: SatValues): void {
  if (sats instanceof EpochSats) sats.compact();
}
