// To run: npx tsc && node test/test.js

const { getTaiDate, getDateFromUtc } = require('../dist/index');

const utc_date = new Date('2017-01-01T00:00:01.000Z');
// const utc_date = new Date('2016-12-31T23:59:59.000Z');
const gps_date = getDateFromUtc(utc_date);

console.log('TAI Date:', getTaiDate(gps_date).toISOString());
console.log('UTC Date:', utc_date.toISOString());
console.log('GPS Date:', gps_date.toISOString());
