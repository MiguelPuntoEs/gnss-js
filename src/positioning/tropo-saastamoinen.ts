/**
 * Saastamoinen tropospheric delay (m) with a standard atmosphere at the
 * receiver's height, mapped by 1/sin(el).
 *
 * Matches RTKLIB's `tropmodel` (relative humidity 0.7) so single-point
 * results stay directly comparable with the rnx2rtkp oracle. Unlike a
 * fixed zenith value, the hydrostatic term is pressure- (i.e. station
 * height-) and latitude-dependent and the wet term is modelled
 * separately — which is what removes the residual vertical bias a
 * constant zenith delay leaves behind, and what a baseline between two
 * receivers at different heights needs.
 */
export function saastamoinenSlantDelay(
  elevationRad: number,
  latRad: number,
  heightM: number
): number {
  if (elevationRad <= 0) return 0;
  // Clamp to the model's valid band (sea level … 10 km), as RTKLIB does.
  const h = heightM < 0 ? 0 : heightM > 1e4 ? 1e4 : heightM;
  const humi = 0.7; // relative humidity assumed absent live met data
  const pres = 1013.25 * Math.pow(1 - 2.2557e-5 * h, 5.2568);
  const temp = 15.0 - 6.5e-3 * h + 273.16; // K, 15 °C at sea level
  const e = 6.108 * humi * Math.exp((17.15 * temp - 4684.0) / (temp - 38.45));
  const zhd =
    (0.0022768 * pres) /
    (1 - 0.00266 * Math.cos(2 * latRad) - 0.00028 * (h / 1e3));
  const zwd = 0.002277 * (1255.0 / temp + 0.05) * e;
  return (zhd + zwd) / Math.sin(elevationRad);
}
