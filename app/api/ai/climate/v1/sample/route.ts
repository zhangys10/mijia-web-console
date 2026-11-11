import { climateRequest } from "../../../../../../lib/ai/api/climate.ts";
import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
export const POST = withRouteDiagnostics("/api/ai/climate/v1/sample", request => climateRequest({ request, env: process.env }, "sample"));
