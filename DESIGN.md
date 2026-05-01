# Multi-Alias Routing — Design Doc

**Branch:** `feat/multi-stage-aliases`
**Status:** Final
**Goal:** Add the ability for `serverless-aws-alias-v4` to manage **more than one** API Gateway stage on the same REST/WebSocket API, with each stage routing to a corresponding Lambda alias. Restores the in-stack blue/green pattern previously provided by `serverless-plugin-aws-alias` (sls v1, abandoned 2019).

---

## Problem

`serverless-aws-alias-v4` v0.5.0 correctly creates per-alias **Lambda** aliases (`prod`, `rc`, etc.) but only manages **one API Gateway stage** per service (whatever `provider.stage` resolves to). When deploying with `--param alias=rc`, the rc Lambda alias is created but there's no `rc` API Gateway stage — so the rc alias is unreachable through API Gateway. Without that, you cannot run prod and rc traffic in parallel against different Lambda alias versions inside one CloudFormation stack.

The integration URI templating (`:${stageVariables.alias}`) and the `alias` stage variable already exist in v0.5.0 — they just only ever apply to one stage. This change extends them to additional stages.

## Investigation summary (upstream support check)

Before designing this, we verified upstream alternatives:

- **Serverless Framework v4 itself**: explicitly does **not** support multiple stages per CFN stack. Per Serverless Inc. maintainer (`pgrzesik`, Stack Overflow Q&A 2023): "Serverless Framework internals are operating under the assumption that each stage is deployed as a separate CloudFormation stack."
- **`serverless-aws-alias-v4`**: source confirms zero multi-stage capability — only one `provider.getStage()` call per deploy method.
- **`serverless-plugin-aws-alias` (v3)**: incompatible with sls v4. Abandoned (last release 2019, sls v1.x only).
- **No other plugin** found that solves this for sls v4.

Conclusion: extend `serverless-aws-alias-v4` itself.

## Design principles

1. **Zero new config.** The user's intent is fully encoded in the `--param alias=…` value they already pass. No `multiStage: true`, no `aliases: [...]` list. The plugin infers everything from `provider.stage` and the resolved alias.
2. **Minimal diff from upstream.** The integration URI template, the stage variable name (`alias`), the existing API ID config keys, and all backward-compatible behavior are preserved. The PR is strictly additive: when `alias === provider.stage` (the default for `dev`/`staging`/`prod`), behavior is identical to v0.5.0.
3. **Idempotent.** Every operation can be re-run without side effects — re-deploys produce the same end state.

## Behavior

When `provider.stage` and the deploying alias are the same (the common case), the plugin's behavior is unchanged from v0.5.0: one stage gets created/updated with `alias=<stage>` and routes to the matching Lambda alias.

When the deploying alias differs from `provider.stage` (e.g. `--stage prod --param alias=rc`):

1. The integration URI templating (`:${stageVariables.alias}`) on each method/route is set as before. This is set once per API and shared across all stages — re-applying is a no-op.
2. A new API Gateway deployment snapshot is created.
3. A stage named `<alias>` is created on the API (or updated if it exists), pointed at the new deployment, with `alias=<alias>` set as its stage variable.
4. The framework stage (`provider.stage`) is also refreshed onto the same deployment with its own `alias=<provider.stage>` variable preserved. This keeps both stages on the same API definition (methods, integrations) so they can't drift, while each stage continues to route to its own Lambda alias version via its stage variable.

The Lambda alias version pointers (`:prod`, `:rc`, etc.) themselves are managed by `createOrUpdateFunctionAliases` exactly as in v0.5.0 — only the alias being deployed gets a new version. Other aliases are untouched.

## Behavior matrix

| Deploy command                              | `provider.stage` | resolved alias | What plugin does                                                                                                                                                                                              |
| ------------------------------------------- | ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sls deploy --stage dev`                    | `dev`            | `dev`          | Manages the `dev` stage with `alias=dev`. Identical to v0.5.0 behavior.                                                                                                                                       |
| `sls deploy --stage prod`                   | `prod`           | `prod`         | Manages the `prod` stage with `alias=prod`. Does not touch any other stage.                                                                                                                                   |
| `sls deploy --stage prod --param alias=rc`  | `prod`           | `rc`           | Creates or updates the `rc` stage on the same API with `alias=rc`; refreshes the `prod` stage's deployment so both stages are on the same API definition. The `prod` stage's `alias=prod` variable preserved. |

## API ID auto-discovery

In v0.5.0, the plugin requires `provider.apiGateway.restApiId` and/or `provider.websocketApiId` to be pre-set. Without them, all API Gateway integration management is silently skipped.

This change adds a `discoverApiIdsFromStack` helper that queries CloudFormation stack outputs `ServiceEndpoint` and `ServiceEndpointWebsocket` (which Serverless Framework emits by default) and parses the API IDs from those URLs. Pre-set IDs always take precedence; auto-discovery only fills in what's missing.

If discovery fails (e.g. stack doesn't exist yet, outputs absent), the plugin falls back to v0.5.0's "skip with warning" behavior — never breaks the deploy.

## Validation

A regex check for the alias name (`/^(?!\$LATEST$)[a-zA-Z0-9_-]{1,128}$/`) is added to `validateConfiguration`. Catches invalid alias names (containing dots, slashes, `$LATEST`, oversized) before any AWS calls are made. AWS would reject these later with less obvious errors.

## Test plan

Service: `budsense-event-service` (has both REST and WebSocket APIs, uses `prod` and `rc` aliases).

### Test 1 — single-alias deploy

`sls deploy --stage dev` from clean state. Verify:
- `dev` stage exists with `alias=dev`
- REST integration URI ends with `:${stageVariables.alias}`
- WebSocket integration URI ends with `:${stageVariables.alias}`
- Lambda permission for `:dev` alias on each method/route
- `GET /dev/get-client-connections` → 200, hits the `:dev` Lambda alias

### Test 2 — multi-alias coexistence

1. `sls deploy --stage prod` from clean state. Verify `prod` stage works (same as Test 1 but on prod).
2. `sls deploy --stage prod --param alias=rc`. Verify:
   - `rc` stage created with `alias=rc`
   - `prod` stage refreshed: now points at the new deployment, but `alias=prod` preserved
   - rc Lambda alias created and Lambda permission for `:rc` added
   - `GET /rc/get-client-connections` → 200, hits the `:rc` Lambda alias
   - `GET /prod/get-client-connections` → 200, hits the `:prod` Lambda alias
3. `sls deploy --stage prod` again. Verify:
   - `prod` Lambda alias bumped to new version
   - `prod` stage points at the new deployment, `alias=prod` preserved
   - `rc` stage completely untouched: still has `alias=rc`, still points at its old deployment, rc Lambda alias still on its old version

### Test 3 — idempotent re-deploy

`sls deploy --stage prod` twice in a row → second deploy is a no-op for stage variables and permissions.

### Test 4 — WebSocket parity

Same scenarios via `wss://...` connections. WebSocket routes (e.g. `HEARTBEAT`, `$connect`) should reach the correct Lambda alias depending on which stage path is used (`/prod` vs `/rc`).

## Backward compatibility

- All existing `custom.alias.*` config keys preserved (`name`, `excludedFunctions`, `verbose`, `skipApiGateway`, `skipWebSocketGateway`).
- `provider.apiGateway.restApiId` and `provider.websocketApiId` still take precedence; auto-discovery only kicks in when they're absent.
- Integration URI template unchanged: still `:${stageVariables.alias}`.
- Stage variable name unchanged: still `alias`.
- Single-alias deploys (where the deploying alias matches `provider.stage`) produce the same AWS state as v0.5.0.

## Implementation outline

~280 LOC additions to `src/index.js`. Touch points:

- New constant `STAGE_VARIABLE_ALIAS = 'alias'` (formalizes the existing convention)
- New constant `VALID_ALIAS_NAME` regex
- `validateConfiguration()` — rejects invalid alias names
- `initializePlugin()` — relaxes the warning when API IDs are absent (now a soft "will discover" message)
- `deployAliasWorkflow()` — calls `discoverApiIdsFromStack` after `getAwsAccountId`
- `updateApiGatewayIntegration()` and `updateWebSocketApiIntegration()` — replace inline `'${stageVariables.alias}'` literal with template referencing the new constant (no behavior change, just refactored)
- `deployApiGateway()` — refactored to deploy to the alias-named stage (creating it if missing) and refresh the framework stage on multi-alias deploys
- `deployWebSocketApi()` — same logic, V2 SDK shape
- New helpers: `discoverApiIdsFromStack`, `extractApiIdFromEndpointUrl`, `patchRestStageAliasVariable`, `refreshRestFrameworkStage`, `upsertWebSocketStage`

README and CHANGELOG updated.

## Out of scope

- Auto-deletion of stale stages (the plugin never deletes anything; manual cleanup if needed)
- Custom domain BasePathMapping per alias (downstream concern; once stages exist, this is a one-line addition in the user's `serverless.yml`)
- HTTP API (v2 non-WebSocket) support
- Multi-region multi-stage
- Per-alias environment variables (Serverless framework handles this via `provider.environment`)
