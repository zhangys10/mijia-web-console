import { climateRequest } from "../../../../../../lib/ai/api/climate.ts";
import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
export const DELETE = withRouteDiagnostics("/api/ai/climate/v1/memory", request => climateRequest({ request, env: process.env }, "memory"));
