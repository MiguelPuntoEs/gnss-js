import {
    MINUTES_IN_DEGREE,
    SECONDS_IN_DEGREE,
    WGS84_ECCENTRICITY_SQUARED,
    WGS84_SEMI_MAJOR_AXIS,
  } from "../constants/coordinates";
  import {
    CoordianteXYZ as CoordinateXYZ,
    CoordinateLLH,
    CoordinateENU,
    CoordinateAER,
  } from "../types/coordinates";
  import { deg2rad } from "./units";
  
  export function geo2car(coordinate: CoordinateLLH): CoordinateXYZ {
    const N =
      WGS84_SEMI_MAJOR_AXIS /
      Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * Math.sin(coordinate.lat) ** 2);
  
    const x =
      (N + coordinate.h) * Math.cos(coordinate.lat) * Math.cos(coordinate.lon);
    const y =
      (N + coordinate.h) * Math.cos(coordinate.lat) * Math.sin(coordinate.lon);
    const z =
      ((1 - WGS84_ECCENTRICITY_SQUARED) * N + coordinate.h) *
      Math.sin(coordinate.lat);
  
    return { x, y, z };
  }
  
  export function car2geo(coordinate: CoordinateXYZ): CoordinateLLH {
    const MAX_ITER = 50;
    const MAX_DELTA_ITER = 1e-15;
    const lon = Math.atan2(coordinate.y, coordinate.x);
    const p = Math.sqrt(coordinate.x ** 2 + coordinate.y ** 2);
    let lati = Math.atan(coordinate.z / p / (1 - WGS84_ECCENTRICITY_SQUARED));
    let iter = 0;
  
    let latiPrev;
    let Ni;
    let hi;
  
    // eslint-disable-next-line no-constant-condition
    while (true) {
      latiPrev = lati;
      Ni =
        WGS84_SEMI_MAJOR_AXIS /
        Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * Math.sin(latiPrev) ** 2);
      hi = p / Math.cos(latiPrev) - Ni;
      lati = Math.atan(
        coordinate.z / p / (1 - (Ni / (Ni + hi)) * WGS84_ECCENTRICITY_SQUARED)
      );
      if (Math.abs(lati - latiPrev) < MAX_DELTA_ITER) {
        break;
      }
      iter += 1;
      if (iter > MAX_ITER) {
        break;
      }
    }
  
    return { lat: lati, lon, h: hi };
  }
  
  export function getPositionFromCartesian(
    x: string,
    y: string,
    z: string
  ): CoordinateXYZ {
    const xParsed = Number.parseFloat(x);
    const yParsed = Number.parseFloat(y);
    const zParsed = Number.parseFloat(z);
  
    if (Number.isNaN(xParsed) || Number.isNaN(yParsed) || Number.isNaN(zParsed))
      return { x: NaN, y: NaN, z: NaN };
  
    if (xParsed === 0 && yParsed === 0) return { x: NaN, y: NaN, z: NaN };
  
    return { x: xParsed, y: yParsed, z: zParsed };
  }
  
  export function getPositionFromGeodetic(
    latitude: string,
    longitude: string,
    height: string
  ) {
    const latitudeParsed = Number.parseFloat(latitude);
    const longitudeParsed = Number.parseFloat(longitude);
    const heightParsed = Number.parseFloat(height);
  
    if (
      Number.isNaN(latitudeParsed) ||
      Number.isNaN(longitudeParsed) ||
      Number.isNaN(heightParsed)
    ) {
      return undefined;
    }
  
    const latitudeRad = deg2rad(latitudeParsed);
    const longitudeRad = deg2rad(longitudeParsed);
  
    return geo2car({ lat: latitudeRad, lon: longitudeRad, h: heightParsed });
  }
  
  export function getEnuDifference(
    coordinate: CoordinateXYZ,
    reference: CoordinateXYZ
  ): CoordinateENU {
    const refLLH = car2geo(coordinate);
  
    const deltaX = coordinate.x - reference.x;
    const deltaY = coordinate.y - reference.y;
    const deltaZ = coordinate.z - reference.z;
  
    const deltaE = -Math.sin(refLLH.lon) * deltaX + Math.cos(refLLH.lon) * deltaY;
    const deltaN =
      -Math.cos(refLLH.lon) * Math.sin(refLLH.lat) * deltaX -
      Math.sin(refLLH.lon) * Math.sin(refLLH.lat) * deltaY +
      Math.cos(refLLH.lat) * deltaZ;
    const deltaU =
      Math.cos(refLLH.lon) * Math.cos(refLLH.lat) * deltaX +
      Math.sin(refLLH.lon) * Math.cos(refLLH.lat) * deltaY +
      Math.sin(refLLH.lat) * deltaZ;
  
    return { E: deltaE, N: deltaN, U: deltaU };
  }
  
  export function getAer(
    coordinate: CoordinateXYZ,
    reference: CoordinateXYZ
  ): CoordinateAER {
    const slant = Math.sqrt(
      (coordinate.x - reference.x) ** 2 +
        (coordinate.y - reference.y) ** 2 +
        (coordinate.z - reference.z) ** 2
    );
  
    if (!slant) return { az: 0, elev: 0, range: 0 };
  
    const enu = getEnuDifference(coordinate, reference);
  
    // console.log(`slant`, slant);
    // console.log(`deltaE`, deltaE);
    // console.log(`deltaN`, deltaN);
    // console.log(`deltaU`, deltaU);
  
    const elevation = Math.asin(enu.U / slant);
    const azimuth = Math.atan2(enu.E, enu.N);
  
    return { elev: elevation, az: azimuth, range: slant };
  }
  
  export function getPositionFromGeodeticString(
    latitudeString: string,
    longitudeString: string,
    height: string
  ) {
    const heightParsed = Number.parseFloat(height);
  
    if (Number.isNaN(heightParsed)) return undefined;
  
    const latitudeDegrees = Number.parseInt(latitudeString.substr(0, 2), 10);
    const latitudeMinutes = Number.parseInt(latitudeString.substr(4, 2), 10);
    const latitudeSeconds = Number.parseFloat(latitudeString.substr(8, 6));
  
    if (
      Number.isNaN(latitudeDegrees) ||
      Number.isNaN(latitudeMinutes) ||
      Number.isNaN(latitudeSeconds)
    ) {
      return undefined;
    }
  
    const latitudeSign =
      latitudeString[latitudeString.length - 1] === "S" ? -1 : 1;
  
    const latitude = deg2rad(
      latitudeSign *
        (latitudeDegrees +
          latitudeMinutes / MINUTES_IN_DEGREE +
          latitudeSeconds / SECONDS_IN_DEGREE)
    );
  
    const longitudeDegrees = Number.parseInt(longitudeString.substr(0, 3), 10);
    const longitudeMinutes = Number.parseInt(longitudeString.substr(5, 2), 10);
    const longitudeSeconds = Number.parseFloat(longitudeString.substr(9, 6));
  
    // console.log(`latitudeDegrees`, latitudeDegrees);
    // console.log(`latitudeMinutes`, latitudeMinutes);
    // console.log(`latitudeSeconds`, latitudeSeconds);
    // console.log(`longitudeDegrees`, longitudeDegrees);
    // console.log(`longitudeMinutes`, longitudeMinutes);
    // console.log(`longitudeSeconds`, longitudeSeconds);
  
    if (
      Number.isNaN(longitudeDegrees) ||
      Number.isNaN(longitudeMinutes) ||
      Number.isNaN(longitudeSeconds)
    )
      return undefined;
  
    const longitudeSign =
      longitudeString[longitudeString.length - 1] === "W" ? -1 : 1;
  
    const longitude = deg2rad(
      longitudeSign *
        (longitudeDegrees +
          longitudeMinutes / MINUTES_IN_DEGREE +
          longitudeSeconds / SECONDS_IN_DEGREE)
    );
  
    return geo2car({ lat: latitude, lon: longitude, h: heightParsed });
  }
  