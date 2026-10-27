export type SpatialMotorAction = {
  action: "open" | "close" | "pause";
  label: "打开" | "关闭" | "暂停";
  value: boolean | number | string;
  propertyKey: string;
  siid: number;
  piid: number;
};

type MotorProperty = {
  key: string;
  name: string;
  writable: boolean;
  siid: number;
  piid: number;
  choices?: Array<{ value: boolean | number | string; label: string; sourceLabel?: string }>;
};

const actions = [
  { action: "open", label: "打开", aliases: new Set(["open", "打开", "开启"]) },
  { action: "close", label: "关闭", aliases: new Set(["close", "关闭"]) },
  { action: "pause", label: "暂停", aliases: new Set(["pause", "暂停"]) },
] as const;

function normalizedLabel(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s_\-]+/g, "");
}

export function spatialMotorActions(properties: MotorProperty[]): SpatialMotorAction[] {
  const property = properties.find(item => item.name === "motor-control" && item.writable && item.choices?.length);
  if (!property?.choices) return [];
  return actions.flatMap(definition => {
    const matches = property.choices!.filter(choice => [choice.sourceLabel, choice.label].filter((value): value is string => Boolean(value)).some(value => definition.aliases.has(normalizedLabel(value))));
    if (matches.length !== 1) return [];
    return [{ action: definition.action, label: definition.label, value: matches[0].value, propertyKey: property.key, siid: property.siid, piid: property.piid }];
  });
}
