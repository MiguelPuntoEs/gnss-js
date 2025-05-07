import { deg2hms } from "./units";

export function formatLatitude(latDeg: number): string {
  const latHms = deg2hms(latDeg);

  return `${latHms.h.toString().padStart(2, "0")}º ${latHms.m
    .toString()
    .padStart(2, "0")}' ${latHms.s.toFixed(3).padStart(6, "0")}" ${
    latDeg >= 0 ? "N" : "S"
  }`;
}

export function formatLongitude(lonDeg: number): string {
  const lonHms = deg2hms(lonDeg);
  return `${lonHms.h.toString().padStart(3, "0")}º ${lonHms.m
    .toString()
    .padStart(2, "0")}' ${lonHms.s.toFixed(3).padStart(6, "0")}" ${
    lonDeg >= 0 ? "E" : "W"
  }`;
}
