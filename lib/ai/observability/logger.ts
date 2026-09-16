type LogFields = Record<string, unknown>;

export function aiCommandLog(event: string, fields: LogFields) {
  console.log(JSON.stringify({ event, ...fields }));
}
