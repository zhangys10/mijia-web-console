import { climateRequest } from "../../../../../../lib/ai/api/climate.ts";
import { withRouteDiagnostics } from "../../../../../../lib/ai/api/diagnostics.ts";
export const GET = withRouteDiagnostics("/api/ai/climate/v1/profiles", request => climateRequest({ request, env: process.env }, "profiles"));
