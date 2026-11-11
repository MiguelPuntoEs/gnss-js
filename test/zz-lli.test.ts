import { it } from 'vitest';
import { readFileSync } from 'fs';
import { parseRinexStream } from '../src/rinex/parser';
it('lli', async () => {
  const run = async (p: string) => {
    const m = new Map<string, string>();
    let set = 0;
    await parseRinexStream(
      new File([new Uint8Array(readFileSync(p))], p.split('/').pop()!),
      undefined,
      undefined,
      (t, prn, codes, v, lli) => {
        codes.forEach((c, i) => {
          if (v[i] != null) {
            const l = lli?.[i] ?? null;
            if (l) {
              set++;
              m.set(t + prn + c, String(l));
            }
          }
        });
      },
      true
    );
    return { m, set };
  };
  for (const [x, y] of [
    ['sur4.crx', 'sur4.rnx'],
    ['inab.25d', 'inab.25o'],
  ]) {
    const a = await run(
      '/private/tmp/claude-501/-Users-miguel-workspace-gnsscalc/46616048-ba44-40cb-8920-0f150274200d/scratchpad/lli/' +
        x
    );
    const b = await run(
      '/private/tmp/claude-501/-Users-miguel-workspace-gnsscalc/46616048-ba44-40cb-8920-0f150274200d/scratchpad/lli/' +
        y
    );
    let diff = 0;
    const ex: string[] = [];
    for (const [k, v] of b.m)
      if (a.m.get(k) !== v) {
        diff++;
        if (ex.length < 5) ex.push(k + ' crx=' + a.m.get(k) + ' rnx=' + v);
      }
    for (const k of a.m.keys())
      if (!b.m.has(k)) {
        diff++;
        if (ex.length < 10) ex.push(k + ' crx=' + a.m.get(k) + ' rnx=-');
      }
    console.log('RESULT', x, a.set, b.set, 'diff', diff, ex.join(' ; '));
  }
}, 600000);
