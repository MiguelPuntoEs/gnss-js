import { defineConfig } from 'tsup';

export default defineConfig({
  target: 'es2022',
  format: ['cjs', 'esm'],
  entry: {
    index: './src/index.ts',
    time: './src/time/index.ts',
    coordinates: './src/coordinates/index.ts',
    constants: './src/constants/index.ts',
    rinex: './src/rinex/index.ts',
    rtcm3: './src/rtcm3/index.ts',
    orbit: './src/orbit/index.ts',
    ntrip: './src/ntrip/index.ts',
    analysis: './src/analysis/index.ts',
    antex: './src/antex/index.ts',
    nmea: './src/nmea/index.ts',
    signals: './src/signals/index.ts',
  },
  dts: true,
  shims: true,
  skipNodeModulesBundle: true,
  clean: true,
});
