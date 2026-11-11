import { climateRequest } from "../../../../../../lib/ai/api/climate.ts";
import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
const handler = withRouteDiagnostics("/api/ai/climate/v1/config", request => climateRequest({ request, env: process.env }, "config"));
export const GET = handler;
export const PUT = handler;
