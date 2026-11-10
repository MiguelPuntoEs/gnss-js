/** Quantiles of the normal and χ² distributions (for statistical tests). */

/** Standard normal quantile (Acklam's rational approximation, ~1e-9). */
export function normalQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const tail = (q: number) =>
    (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
      c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const rr = q * q;
  return (
    ((((((a[0]! * rr + a[1]!) * rr + a[2]!) * rr + a[3]!) * rr + a[4]!) * rr +
      a[5]!) *
      q) /
    (((((b[0]! * rr + b[1]!) * rr + b[2]!) * rr + b[3]!) * rr + b[4]!) * rr + 1)
  );
}

/** χ² quantile with `dof` degrees of freedom (Wilson–Hilferty; within ~1%
 *  for dof ≥ 3, conservative below). */
export function chi2Quantile(p: number, dof: number): number {
  const z = normalQuantile(p);
  const a = 2 / (9 * dof);
  return dof * Math.max(0, 1 - a + z * Math.sqrt(a)) ** 3;
}
