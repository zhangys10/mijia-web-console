# Python Agent extraction

Agent development is being extracted into the prepared `mijia-agent` project. The
companion source baseline is PR #31 (`3009be70bf82f90ad5b3b51de9f8f17b1c7f213d`),
including the stacked quota/Makers/chat work that is not all on `main`.

The console remains responsible for QR login, encrypted Xiaomi sessions, principal
derivation, home authorization, scene alias mapping and safe execution. Python owns model
access and intent/tool orchestration. A thin Makers adapter in the new repo owns platform
conversation storage, agent usage quotas, and forwards bounded turns to Python.

## Added contract

- `POST /api/ai/tools`: internal Bearer authentication via `AI_TOOLS_INTERNAL_SECRET`.
- Envelope: requestId, principalId, homeId, scopes, sessionBinding, optional idempotencyKey,
  tool and arguments. No new Xiaomi credentials leave the console.
- Binding is decrypted only here; principal is re-derived and current home access rechecked.
- `authorize` returns `{ok:true}`; `list_scenes` returns sanitized alias/name/description/actionCount.
- `activate_scene` currently returns `AI_SCENE_EXECUTION_DISABLED`; remote control requires
  durable cross-conversation atomic execution claims plus reviewed scene revision/risk checks.
- Optional server-only `AI_AGENT_BASE_URL` selects the new Makers origin for chat/delete
  and quota summaries. The production Makers origin is `https://agent.fabloki.xyz`.
  In that mode the adapter owns quota reserve/commit; the console does not maintain a second
  ledger. Unset preserves same-project routing and the local quota path. The Python URL is
  not used here.

This is a draft, read-only integration boundary, not a production migration. Existing Agent
code and public API shapes are preserved for rollback. Keep `AI_COMMAND_ENABLED=false`.

Before cutover, propagate/settle known model usage on errors, map uncertain execution errors,
test real KV binding/soft quota behavior, verify preview mock behavior at ingress, and verify
standalone Makers routing/store/cancellation against the new project. Do not assume the
current conversation-scoped store supplies global atomic idempotency.
