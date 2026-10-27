export type SpatialIconKind = "light" | "climate" | "curtain" | "camera" | "sensor" | "fan" | "vacuum" | "gateway" | "generic";

export function spatialIconKind(kind: string | undefined, lighting = false, group = false): SpatialIconKind {
  if (lighting || group || kind === "light" || kind === "lamp") return "light";
  if (kind === "aircondition" || kind === "acpartner" || kind === "airpurifier" || kind === "humidifier") return "climate";
  if (kind === "curtain") return "curtain";
  if (kind === "camera") return "camera";
  if (kind === "sensor") return "sensor";
  if (kind === "fan") return "fan";
  if (kind === "vacuum") return "vacuum";
  if (kind === "gateway") return "gateway";
  return "generic";
}

const paths: Record<SpatialIconKind, string> = {
  light: '<path d="M7 14h10M9 18h6M12 2a6 6 0 0 0-3.8 10.6c.8.7 1.3 1.4 1.5 2.4h4.6c.2-1 .7-1.7 1.5-2.4A6 6 0 0 0 12 2Z"/>',
  climate: '<path d="M4 7h16v7H4zM7 17c2 0 2 3 4 3s2-3 4-3 2 3 4 3"/>',
  curtain: '<path d="M4 3h16M6 4v17l6-3V4m6 0v17l-6-3"/>',
  camera: '<path d="M4 7h11v10H4zM15 10l5-3v10l-5-3M7 7l1-3h4l1 3"/>',
  sensor: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4 0a6 6 0 0 0 0-8.4M4.6 4.6a10.5 10.5 0 0 0 0 14.8m14.8 0a10.5 10.5 0 0 0 0-14.8"/>',
  fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10c-1-4 1-7 4-6 2 1 1 5-2 7m-4 1c-4 1-7-1-6-4 1-2 5-1 7 2m1 4c1 4-1 7-4 6-2-1-1-5 2-7"/>',
  vacuum: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M7 17h10"/>',
  gateway: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 9h8"/>',
  generic: '<rect x="5" y="4" width="14" height="16" rx="3"/><circle cx="12" cy="15" r="1"/><path d="M9 8h6"/>',
};

export function spatialIconSvg(kind: SpatialIconKind) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}
