# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Throttle-aware retries on every AWS call.** Lambda's control-plane APIs (everything except invocations, `GetFunction`, and `GetPolicy`) share one account-wide 15 req/s quota that AWS does not raise, so concurrent service deploys routinely hit `Rate exceeded`. Every Lambda, API Gateway, CloudFormation, and STS call now retries throttling errors with exponential backoff and jitter (8 retries, 400ms base, 10s cap). Non-throttling errors are rethrown immediately, preserving all `ResourceNotFoundException` control flow.
- **Multi-alias routing on a single API.** Deploying with `--param alias=<name>` (when `<name>` differs from `provider.stage`) now creates a parallel API Gateway stage named `<name>` on the same REST and/or WebSocket API. Both stages share one CloudFormation stack and one set of methods/integrations; each stage routes to its corresponding Lambda alias via stage variables. This unlocks in-stack blue/green deploys (e.g. keeping `prod` and `rc` on a single stack with shared infrastructure) without any new configuration.
- On multi-alias deploys, the framework stage is refreshed onto the same API Gateway deployment as the alias stage, so both stages stay in sync on API definition while preserving each stage's own alias routing.
- **Auto-discovery of API IDs from CloudFormation stack outputs.** When `provider.apiGateway.restApiId` and `provider.websocketApiId` are not pre-supplied, the plugin reads the `ServiceEndpoint` and `ServiceEndpointWebsocket` outputs that Serverless Framework emits by default. Pre-supplied IDs always take precedence. Services whose APIs are created in the same stack no longer need extra configuration to enable API Gateway integration management.
- Validation of the alias name against AWS Lambda alias and API Gateway stage name rules (alphanumerics, dashes, underscores; up to 128 characters; not `$LATEST`). Invalid names are rejected before any AWS calls are made.
- Documented alias lifecycle semantics: the plugin is non-destructive and does not auto-delete stale API Gateway stages or Lambda aliases; cleanup is manual.

### Changed

- **Alias failures now fail the deploy.** Previously, a function whose alias could not be checked/published/updated only produced a `WARNING: Failed to process aliases for N functions` log line and the deploy exited 0 — leaving aliases silently pointing at stale versions. `createOrUpdateFunctionAliases` now throws after the loop when any function failed, so CI retry wrappers can detect and rerun the deploy.
- **Redundant configuration update before publish is skipped.** `publishNewFunctionVersion` used to unconditionally call `updateFunctionConfiguration` and poll `LastUpdateStatus` before publishing. The CloudFormation deploy that runs before the alias hook already applies the same merged environment, so the update (and its polling) now only runs when the live environment actually differs. If a prior update is still `InProgress`, the publish still waits for it to settle.
- Configuration reads use `GetFunction` (dedicated 100 req/s quota) instead of `GetFunctionConfiguration` (shared 15 req/s quota), keeping change-detection reads out of the contended control-plane bucket.
- One SDK client is constructed per AWS service per deploy instead of one per call.
- `createOrUpdateAlias` accepts the already-fetched alias from the deploy loop instead of re-fetching it, saving one `GetAlias` call per function.
- A change-detection or version-listing call that is still throttled after all retries now fails that function instead of silently publishing a new version or pinning the alias to `$LATEST`.
- Standardized integration URI routing on `${stageVariables.alias}` while writing both `alias` and `SERVERLESS_ALIAS` stage variables for compatibility with legacy v3-style integrations.

### Unchanged

- Single-alias deploys (the case where the deploying alias matches `provider.stage`) behave identically to v0.5.0.
- The integration URI continues to use API Gateway stage-variable alias routing and the plugin continues to set the routing stage variable on managed stages.

## [0.5.0] - 2025-09-16

Initial baseline tagged when this fork was created. See upstream releases at
<https://github.com/Castlenine/serverless-aws-alias-v4/releases> for prior history.
