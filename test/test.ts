// To run: npx ts-node test/test.ts

import { getTaiDate, getDateFromUtc } from '../src/index';

const utc_date = new Date('2017-01-01T00:00:01.000Z');
const gps_date = getDateFromUtc(utc_date);

console.log('TAI Date:', getTaiDate(gps_date).toISOString());
console.log('UTC Date:', utc_date.toISOString());
console.log('GPS Date:', gps_date.toISOString());
