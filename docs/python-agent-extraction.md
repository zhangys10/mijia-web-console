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
- `authorize` returns `{ok:true}`; `list_scenes` returns sanitized alias/name/description/actionCount.
- `activate_scene` currently returns `AI_SCENE_EXECUTION_DISABLED`; remote control requires
  durable cross-conversation atomic execution claims plus reviewed scene revision/risk checks.
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
deployment is the only agent runtime. Keep `AI_COMMAND_ENABLED=false`.

The console maps uncertain execution errors, enforces the Preview mock at the outer
chat ingress, and requires a quota summary from the adapter when quota is enabled — a remote
turn that returns no quota summary fails `502` by design. Usage settlement and unknown-outcome
accounting are owned by the remote adapter. Real KV soft-quota
behavior and standalone Makers routing/store/cancellation also remain to be validated. Do not
assume the current conversation-scoped store supplies global atomic idempotency.
