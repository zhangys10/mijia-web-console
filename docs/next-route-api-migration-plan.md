# Migrate Console APIs to Next Route Handlers

Status: implemented in source; preview and production cutover validation remain pending. This document does not authorize a production deployment.

## Goal and scope

Make `app/api/**/route.ts` the only HTTP API entrypoints in `mijia-web-console`. Remove the Console's `edge-functions/` route files so EdgeOne, Vercel, and the local Next-compatible build use the same URL owners. Keep the Agent runtime and its orchestration in the separate `mijia-agent` repository; this plan changes only the Console.

The Console currently has no `cloud-functions/` directory. The platform-specific routes to remove are seven **Edge Functions**. EdgeOne Makers [supports Next Route Handlers](https://pages.edgeone.ai/document/framework-nextjs) and lists Next SSR logs in [Log Analysis](https://pages.edgeone.ai/document/log-analysis); Edge Function log collection is not yet available there. `edgeone.json` remains the configuration for building the native Next `.next` output, not an API route marker.

## Current route inventory

Every Edge Function URL below already has a matching Next route. Other Console APIs, including `/api/ai/tools`, `/api/ai/automation-token`, and `/api/xiaomi/*`, are already owned by `app/api/` and should retain their contracts.

| URL | Current Edge Function | Existing Next route |
| --- | --- | --- |
| `POST /api/ai/chat` | `edge-functions/api/ai/chat.ts` | `app/api/ai/chat/route.ts` |
| `POST /api/ai/conversations` | `edge-functions/api/ai/conversations.ts` | `app/api/ai/conversations/route.ts` |
| `DELETE /api/ai/conversations/:conversationId` | `edge-functions/api/ai/conversations/[conversationId].ts` | `app/api/ai/conversations/[conversationId]/route.ts` |
| `GET`, `PUT /api/ai/exposure` | `edge-functions/api/ai/exposure.ts` | `app/api/ai/exposure/route.ts` |
| `GET /api/ai/quota` | `edge-functions/api/ai/quota.ts` | `app/api/ai/quota/route.ts` |
| `POST /api/internal/assistant/v1/capabilities` | `edge-functions/api/internal/assistant/v1/capabilities.ts` | `app/api/internal/assistant/v1/capabilities/route.ts` |
| `POST /api/internal/assistant/v1/tools:invoke` | `edge-functions/api/internal/assistant/v1/tools:invoke.ts` | `app/api/internal/assistant/v1/tools:invoke/route.ts` |

## Implementation sequence

### 1. Give the Next routes one shared implementation

- Move reusable request handlers and their dependency-injection seams from `edge-functions/api/**` into server-only modules under `lib/ai/`. Keep authentication, body limits, preview behavior, authorization, response shape, status codes, and `Cache-Control: no-store` unchanged unless a change is called out below.
- Have each existing `app/api/**/route.ts` export its actual HTTP methods and call the shared handler directly. Remove imports from `edge-functions/`. Read server configuration at the Next route boundary and pass it explicitly to shared code; no shared module should read `process.env` at import time. Next Route Handlers do not receive the Edge Function `context.env` object, so verify EdgeOne injects the required settings into the server runtime before cutover.
- Keep local `AI_ENVIRONMENT=development` exposure storage under `AI_ASSISTANT_EXPOSURE_DIR`. Production must continue to use Blob and fail closed if it is unavailable. Keep session cookies, automation tokens, internal secrets, principal/home identity, real DIDs, and raw Xiaomi responses out of model input and logs.
- Remove the seven `edge-functions/` files only after all imports and tests use the Next routes or shared modules. Do not leave two route owners for the same URL.

### 2. Resolve storage before deleting the Edge routes

- **Exposure:** retain the current `@edgeone/pages-blob` store and strong-consistency reads. Blob supports EdgeOne server functions according to the [Blob documentation](https://pages.edgeone.ai/document/blob-storage). Verify read/write behavior with a separate staging namespace and test home, then verify a production Next route can read the existing production namespace and hashed home keys without modifying them. If automatic project credentials are unavailable in Next SSR, use the existing explicit `PAGES_PROJECT_ID` and `PAGES_BLOB_API_TOKEN` configuration; never fall back to memory or a different namespace in production.
- **Quota:** `edge-functions/api/ai/quota.ts` has a legacy fallback that reads an EdgeOne KV binding from `globalThis`. [EdgeOne KV is available only in Edge Functions](https://pages.edgeone.ai/document/kv-storage), so this branch cannot move unchanged. In the Next route, return the disabled summary when `AI_QUOTA_ENABLED=false`; otherwise query the configured remote Agent, which owns quota accounting. If the Agent configuration or request fails, return a sanitized, fail-closed error. Remove the Console KV fallback and its obsolete configuration/docs after checking all references. Do not move quota writes into the Console.

### 3. Make failures diagnosable in Next SSR logs

- Emit structured logs with a request ID, route, stage, HTTP status, and bounded error category. Do not log cookies, tokens, session bindings, principal/home IDs, DIDs, device names, readings, request bodies, or raw exception messages.
- For `get_home_environment`, report aggregate reasons for a `partial` snapshot: specification lookup failures, failed property batches, missing/nonzero/invalid individual property results, and exposure response truncation. The current collector returns `partial` when valid values are fewer than planned reads, but its `warnings` array does not explain individual property failures. Keep these counters server-side; the model-facing result remains sanitized.
- Preserve the current safe public error codes. An exception during module import still precedes route-level error handling, so include a build/import check for the native Next output.

### 4. Update tests and documentation

- Retarget tests that import `edge-functions/` modules to the shared handlers and Next route exports. Cover method rejection, authenticated and unauthenticated calls, token environment matching, home/exposure authorization, Blob failure, preview behavior, quota disabled/Agent unavailable paths, and safe error logging. Keep fake credentials only.
- Update `README.md`, `docs/architecture.md`, and `docs/local-integration-test.md`. In particular, remove the claim that Next routes are local-only on EdgeOne and remove instructions that require starting Console Edge Functions for local integration.
- Run the repository gates: `npm run typecheck`, `npm run lint`, and `npm test`. Also run `npm run build:edgeone` because `npm test` builds with Vinext, while EdgeOne deploys the native Next `.next` output. Check `npm run build:vercel` if shared route changes affect that target.

### 5. Verify the deployed route owner and cut over

- On an EdgeOne preview deployment, call each URL with a method or missing authentication that cannot touch Xiaomi devices, and confirm the response comes from the Next route with the expected status and `no-store` header. Confirm those requests appear in the SSR log source rather than requiring an Edge Function log.
- Use an isolated staging deployment and test home for authenticated read-only checks of token validation, exposure Blob access, `/api/ai/tools`, and both assistant v1 endpoints. Set `APP_ENV` consistently for its token issuer and verifier. A deployment with `AI_ENVIRONMENT=preview` is expected to block tool invocation, so it cannot prove a successful live read. Confirm a `partial` environment result produces an aggregate reason in SSR logs. Do not test physical device writes as part of this migration.
- Verify the production environment variables needed by the Next server runtime, especially `APP_ENV`, `XIAOMI_SESSION_SECRET`, `AI_AUTOMATION_TOKEN_SECRET`, `AI_TOOLS_INTERNAL_SECRET`, `AI_PRINCIPAL_SECRET`, `AI_AGENT_BASE_URL`, and Blob credentials if required. Check only presence and expected non-secret values; do not print secrets.
- After preview validation and normal review, release the migration as one route-owner change. Monitor SSR error rates and assistant read outcomes. A rollback uses the previous deployment; do not add an automatic fallback from Next to Edge Functions.

## Completion criteria

1. No Console API imports or route files remain under `edge-functions/` or `cloud-functions/`; all `/api/*` URLs have one Next Route Handler owner.
2. Existing security, preview, no-store, response, and read-only behavior is preserved. Quota remains owned by the remote Agent and fails closed when unavailable.
3. Native EdgeOne Next build and preview requests prove the v1 tools can access the existing Blob exposure records, and SSR logs show safe partial/failure categories.
4. Console docs and tests describe the new route ownership. No changes are required in `mijia-agent` or to external API URLs.
