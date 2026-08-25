const ALLOWED_DOMAINS = new Set([
  "light", "switch", "fan", "climate", "cover", "lock", "vacuum",
  "humidifier", "media_player", "sensor", "binary_sensor", "scene",
]);

export type HaEntity = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
};

function config() {
  const baseUrl = process.env.HA_BASE_URL?.replace(/\/$/, "");
  const token = process.env.HA_ACCESS_TOKEN;
  if (!baseUrl || !token) throw new Error("HOME_ASSISTANT_NOT_CONFIGURED");
  if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
    throw new Error("HOME_ASSISTANT_URL_INVALID");
  }
  return { baseUrl, token };
}

export async function haRequest(path: string, init?: RequestInit) {
  const { baseUrl, token } = config();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HOME_ASSISTANT_HTTP_${response.status}`);
  return response.json();
}

export function publicEntities(entities: HaEntity[]) {
  return entities.filter((entity) => ALLOWED_DOMAINS.has(entity.entity_id.split(".")[0])).map((entity) => ({
    entityId: entity.entity_id,
    domain: entity.entity_id.split(".")[0],
    state: entity.state,
    name: String(entity.attributes.friendly_name ?? entity.entity_id),
    unit: entity.attributes.unit_of_measurement ?? null,
    brightness: entity.attributes.brightness ?? null,
    temperature: entity.attributes.temperature ?? entity.attributes.current_temperature ?? null,
    battery: entity.attributes.battery_level ?? null,
    deviceClass: entity.attributes.device_class ?? null,
    lastChanged: entity.last_changed,
  }));
}

export function assertEntityId(value: unknown) {
  if (typeof value !== "string" || !/^[a-z_]+\.[a-z0-9_]+$/.test(value)) throw new Error("INVALID_ENTITY_ID");
  const domain = value.split(".")[0];
  if (!ALLOWED_DOMAINS.has(domain)) throw new Error("DOMAIN_NOT_ALLOWED");
  return { entityId: value, domain };
}
