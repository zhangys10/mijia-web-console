# Python Agent extraction

Agent development is being extracted into the prepared `mijia-agent` project. The
companion source baseline is console `main` after the stacked quota/Makers/chat work was
squashed into PR #34 (`e40cf0c`).

The console remains responsible for QR login, encrypted Xiaomi sessions, principal
derivation, home authorization, scene alias mapping and safe execution. Python owns model
access and intent/tool orchestration. A thin Makers adapter in the new repo owns platform
conversation storage, agent usage quotas, and forwards bounded turns to Python.

## Added contract

- `POST /api/ai/tools`: internal Bearer authentication via `AI_TOOLS_INTERNAL_SECRET`.
- Envelope: requestId, principalId, homeId, scopes, sessionBinding, optional idempotencyKey,
  tool and arguments. No new Xiaomi credentials leave the console.
- Binding is decrypted only here; principal is re-derived and current home access rechecked.
- `authorize` returns `{ok:true}`. `list_scenes` returns only scenes approved for the current home whose content still matches the approved revision and whose normalized actions pass the conservative low-risk policy; summaries use opaque aliases and contain no real scene IDs or DIDs.
- `get_home_status` returns a sanitized read-only home snapshot; it stays out of preview.
- `get_device_status` returns a sanitized read-only per-room device on/off snapshot
  (the same device pipeline and lighting model as the 首页 dashboard); it stays out of preview.
- `activate_scene` revalidates the home-scoped alias, approval, scene revision and risk, then requires a durable cross-conversation Blob claim before dispatch. Remote execution remains disabled by default until the deployed concurrency, recovery and end-to-end gates in the agent repo's `docs/TODO.md` pass.
- Optional `X-Ai-User-Token` header (checked after the service Bearer) adds a user
  automation-token ingress for the Python agent's `/ai/command` pipeline. The token is
  opaque to the agent; only this console opens it (`AI_AUTOMATION_TOKEN_SECRET`),
  re-derives the principal from the embedded Xiaomi session, and resolves the home the
  way `/api/ai/command` does: explicit request `home` (ID, exact name, then substring),
  the token-bound homeId (failing closed if no longer owned), then the account's first
  home. Tokens issued after phase 3 carry no BYOK provider/model/apiKey fields at all;
  legacy tokens that still do are ignored on this path — model access stays
  with the Makers Gateway in the agent. On this path the body envelope is
  requestId/home/tool/arguments/idempotencyKey; the binding-only fields are rejected so
  the two envelopes cannot be mixed. Tool semantics are identical to the binding path,
  including the disabled activation.
- Required server-only `AI_AGENT_BASE_URL` selects the Makers origin for chat/delete
  and quota summaries. The production Makers origin is `https://agent.fabloki.xyz`.
  The adapter owns quota reserve/commit; the console does not maintain a second
  ledger. Unset fails non-preview chat/delete with `502 AI_AGENT_UNAVAILABLE`
  (the embedded agent was removed from this repo). The Python URL is
  not used here.
- Quota implementation is deferred (M3): while the adapter quota surface does not exist,
  remote mode runs with `AI_QUOTA_ENABLED=false`. The console then requires no adapter
  quota summary, never calls `POST /api/internal/quota`, and synthesizes a principal-bound
  `mode: "disabled"` summary itself. This means no limits, no usage accounting, and no
  model-cost protection — development-only. Re-enabling quota requires the adapter to
  implement settlement, chat quota summaries, and `POST /api/internal/quota` first.

This is a draft, read-only integration boundary, not a production migration. The embedded
agent runtime and its rollback copy have been removed from this repo; the remote `mijia-agent`
deployment is the only agent runtime. The legacy `/api/ai/command` route has been retired
(410 `AI_COMMAND_RETIRED`): command traffic uses the agent's automation-token ingress.
Automation-token generation on the settings page no longer carries BYOK provider/model/apiKey
fields — the token seals only the Xiaomi session and an optional bound home.

The console maps uncertain execution errors, enforces the Preview mock at the outer
chat ingress, and requires a quota summary from the adapter when quota is enabled — a remote
turn that returns no quota summary fails `502` by design. Usage settlement and unknown-outcome
accounting are owned by the remote adapter. Real KV soft-quota
behavior and standalone Makers routing/store/cancellation also remain to be validated. Do not
assume the current conversation-scoped store supplies global atomic idempotency.
