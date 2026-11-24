# Climate profile Phase 1 validation

- Configure sensor/actuator pairs and confirm only opaque references reach the browser.
- Verify immediate, visible two-minute sampling; visibility/network resume; cancellation;
  one request in flight; and 5/15-minute backoff.
- Verify 15-minute sample deduplication, two-sample external stabilization, confirmed
  Console-write attribution, 90-day retention, and home-isolated Blob keys.
- Verify periodic ambient/setpoint/mode points can produce a provisional recommendation
  without manual changes. Confirm AC recommendations include mode, while manual changes
  remain higher-weight evidence and are required for a learned cell. Published AC mode
  names must appear in recommendations, history, timelines and matrices instead of enum
  numbers; adding labels to an existing mapping must preserve its history.
- For a multi-service boiler, verify only an explicit thermostat/room-heating setpoint and
  the on/off property on that same service are used. A boiler without that setpoint is not
  offered; domestic-hot-water and boiler-controller fallbacks are never used.
- Change a configured controller's capability revision and verify its old samples,
  observations, profile cells and review pointer are removed before the new property is
  sampled; a former water-heater value must not remain in thermostat history.
- Review sparse/learned matrix cells and observation exclusion, restore, derive, review,
  export, and delete flows on desktop, iPad, narrow mobile, keyboard, and screen reader.
- Run `npm run typecheck`, `npm run lint`, and `npm test`.
- Confirm no Phase 1 endpoint reaches property-set, actions, scenes, automations, or an
  executor. Mocked tests are not live EdgeOne or Xiaomi validation.
