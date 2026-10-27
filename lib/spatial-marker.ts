export function shouldExpandSpatialMarker(zoom: number, wasExpanded: boolean, forced = false) {
  if (forced) return true;
  return zoom >= (wasExpanded ? 2 : 2.4);
}
