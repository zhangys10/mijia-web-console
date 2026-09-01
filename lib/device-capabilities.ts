import type {
  MiotCapabilityAction,
  MiotCapabilityEvent,
  MiotCapabilityGroup,
  MiotCapabilityProperty,
} from "./miot-spec.ts";

export type MiotPropertyAccess = "read-only" | "read-write" | "write-only" | "unavailable";

export type ExecutableMiotAction = MiotCapabilityAction & {
  inputProperties: MiotCapabilityProperty[];
  unresolvedInputPiids: number[];
};

export type DeviceCapabilitySections = {
  readOnlyProperties: MiotCapabilityProperty[];
  readWriteProperties: MiotCapabilityProperty[];
  writeOnlyProperties: MiotCapabilityProperty[];
  unavailableProperties: MiotCapabilityProperty[];
  executableActions: ExecutableMiotAction[];
  events: MiotCapabilityEvent[];
};

export function miotPropertyAccess(property: Pick<MiotCapabilityProperty, "readable" | "writable">): MiotPropertyAccess {
  if (property.readable && property.writable) return "read-write";
  if (property.readable) return "read-only";
  if (property.writable) return "write-only";
  return "unavailable";
}

export function splitDeviceCapabilityGroup(group: MiotCapabilityGroup): DeviceCapabilitySections {
  const sections: DeviceCapabilitySections = {
    readOnlyProperties: [],
    readWriteProperties: [],
    writeOnlyProperties: [],
    unavailableProperties: [],
    executableActions: group.actions.map(action => {
      const inputProperties = action.inputs.flatMap(piid => {
        const property = group.properties.find(candidate => candidate.piid === piid);
        return property ? [property] : [];
      });
      const resolvedPiids = new Set(inputProperties.map(property => property.piid));
      return {
        ...action,
        inputProperties,
        unresolvedInputPiids: action.inputs.filter(piid => !resolvedPiids.has(piid)),
      };
    }),
    events: [...group.events],
  };
  for (const property of group.properties) {
    const access = miotPropertyAccess(property);
    if (access === "read-only") sections.readOnlyProperties.push(property);
    else if (access === "read-write") sections.readWriteProperties.push(property);
    else if (access === "write-only") sections.writeOnlyProperties.push(property);
    else sections.unavailableProperties.push(property);
  }
  return sections;
}
