import type { SpatialEnvironmentMode } from "./spatial-environment.ts";

export type SpatialCoordinates = { latitude: number; longitude: number };

const cityCoordinates: Record<string, SpatialCoordinates> = {
  "Asia/Shanghai": { latitude: 31.23, longitude: 121.47 },
  "Asia/Hong_Kong": { latitude: 22.32, longitude: 114.17 },
  "Asia/Tokyo": { latitude: 35.68, longitude: 139.69 },
  "Asia/Singapore": { latitude: 1.35, longitude: 103.82 },
  "Australia/Sydney": { latitude: -33.87, longitude: 151.21 },
  "Europe/London": { latitude: 51.51, longitude: -.13 },
  "America/New_York": { latitude: 40.71, longitude: -74.01 },
  "America/Los_Angeles": { latitude: 34.05, longitude: -118.24 },
};

export function spatialLocalCoordinates(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): SpatialCoordinates {
  return cityCoordinates[timeZone] ?? { latitude: 35, longitude: -date.getTimezoneOffset() / 4 };
}

function dayOfYear(date: Date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000);
}

function normalize(value: number, maximum: number) { return (value % maximum + maximum) % maximum; }
function degrees(value: number) { return value * 180 / Math.PI; }
function radians(value: number) { return value * Math.PI / 180; }

/** NOAA sunrise equation, returned as an instant on the supplied local calendar date. */
export function spatialSunEvent(date: Date, coordinates: SpatialCoordinates, sunrise: boolean) {
  const localNoon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const n = dayOfYear(new Date(Date.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate())));
  const longitudeHour = coordinates.longitude / 15;
  const approximate = n + ((sunrise ? 6 : 18) - longitudeHour) / 24;
  const meanAnomaly = .9856 * approximate - 3.289;
  let longitude = meanAnomaly + 1.916 * Math.sin(radians(meanAnomaly)) + .02 * Math.sin(radians(2 * meanAnomaly)) + 282.634;
  longitude = normalize(longitude, 360);
  let rightAscension = normalize(degrees(Math.atan(.91764 * Math.tan(radians(longitude)))), 360);
  rightAscension += Math.floor(longitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;
  const sinDeclination = .39782 * Math.sin(radians(longitude));
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  const cosineHour = (Math.cos(radians(90.833)) - sinDeclination * Math.sin(radians(coordinates.latitude))) / (cosDeclination * Math.cos(radians(coordinates.latitude)));
  if (cosineHour < -1 || cosineHour > 1) return null;
  const hourAngle = (sunrise ? 360 - degrees(Math.acos(cosineHour)) : degrees(Math.acos(cosineHour))) / 15;
  const utcHours = normalize(hourAngle + rightAscension - .06571 * approximate - 6.622 - longitudeHour, 24);
  const utcMidnight = Date.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate());
  let instant = utcMidnight + utcHours * 3_600_000;
  while (instant - localNoon.getTime() > 43_200_000) instant -= 86_400_000;
  while (localNoon.getTime() - instant > 43_200_000) instant += 86_400_000;
  return new Date(instant);
}

export function spatialEnvironmentAt(date = new Date(), coordinates = spatialLocalCoordinates(date)): SpatialEnvironmentMode {
  const sunrise = spatialSunEvent(date, coordinates, true), sunset = spatialSunEvent(date, coordinates, false);
  if (!sunrise || !sunset) return date.getHours() >= 6 && date.getHours() < 18 ? "day" : "night";
  // When the browser timezone differs from the supplied coordinates, the
  // returned instants can straddle UTC midnight even though they belong to
  // the same local solar date. Normalize that ordering before comparing.
  const normalizedSunrise = sunrise > sunset
    ? new Date(sunrise.getTime() - 86_400_000)
    : sunrise;
  return date >= normalizedSunrise && date < sunset ? "day" : "night";
}
