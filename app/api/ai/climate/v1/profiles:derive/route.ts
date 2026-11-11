import { climateRequest } from "../../../../../../lib/ai/api/climate.ts";
import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
export const POST = withRouteDiagnostics("/api/ai/climate/v1/profiles:derive", request => climateRequest({ request, env: process.env }, "derive"));
