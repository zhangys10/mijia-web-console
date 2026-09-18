export type AgentTraceEvent =
  | {
      type: "model_call";
      requestId: string;
      model: string;
      latencyMs: number;
    }
  | {
      type: "tool_call";
      requestId: string;
      tool: "list_scenes" | "activate_scene";
      status: "success" | "rejected" | "failed";
      latencyMs: number;
    };

export class AgentTraceCollector {
  readonly events: AgentTraceEvent[] = [];

  record(event: AgentTraceEvent) {
    this.events.push(event);
  }
}
