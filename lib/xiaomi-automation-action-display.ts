export type AutomationActionValue = boolean | number | string;

export type AutomationActionProperty = {
  siid: number;
  piid: number;
  value: AutomationActionValue;
  label?: string;
};

export type AutomationActionForDisplay = {
  did: string;
  label: string;
  properties?: AutomationActionProperty[];
};

export type AutomationPropertyCatalogEntry = {
  did: string;
  siid: number;
  piid: number;
  serviceLabel?: string;
  label: string;
  format: string;
  editable?: boolean;
  range?: { min: number; max: number; step: number };
  choices?: Array<{ value: AutomationActionValue; label: string }>;
};

function cleanLabel(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sameValue(left: AutomationActionValue, right: AutomationActionValue) {
  return typeof left === typeof right && left === right;
}

function catalogLabel(entry: AutomationPropertyCatalogEntry) {
  return [cleanLabel(entry.serviceLabel), cleanLabel(entry.label)]
    .filter((label, index, labels) => label && labels.indexOf(label) === index)
    .join(" · ");
}

function actionDescription(action: AutomationActionForDisplay) {
  const label = cleanLabel(action.label);
  return label && !["未命名动作", "设置设备属性", "执行设备动作", "设备动作"].includes(label) ? label : "";
}

export function automationPropertyDisplay(
  action: AutomationActionForDisplay,
  property: AutomationActionProperty,
  catalog: AutomationPropertyCatalogEntry[],
) {
  const descriptor = catalog.find(entry =>
    entry.did === action.did
    && entry.siid === property.siid
    && entry.piid === property.piid
  );
  const label = descriptor
    ? catalogLabel(descriptor)
    : cleanLabel(property.label)
      || (action.properties?.length === 1 ? actionDescription(action) : "")
      || "未识别属性";
  const choice = descriptor?.choices?.find(item => sameValue(item.value, property.value));
  const valueLabel = cleanLabel(choice?.label)
    || (typeof property.value === "boolean" ? property.value ? "开启" : "关闭" : String(property.value));
  return { label, valueLabel, known: Boolean(descriptor), descriptor };
}
