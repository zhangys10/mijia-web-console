import { climateRequest } from "../../../../../../lib/ai/api/climate.ts";
import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
const handler = withRouteDiagnostics("/api/ai/climate/v1/observations", request => climateRequest({ request, env: process.env }, "observations"));
export const GET = handler;
export const PATCH = handler;
