# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-alias routing on a single API.** Deploying with `--param alias=<name>` (when `<name>` differs from `provider.stage`) now creates a parallel API Gateway stage named `<name>` on the same REST and/or WebSocket API. Both stages share one CloudFormation stack and one set of methods/integrations; each stage routes to its corresponding Lambda alias via the `SERVERLESS_ALIAS` stage variable. This unlocks in-stack blue/green deploys (e.g. keeping `prod` and `rc` on a single stack with shared infrastructure) without any new configuration.
- On multi-alias deploys, the framework stage is refreshed onto the same API Gateway deployment as the alias stage, so both stages stay in sync on API definition while preserving each stage's own alias routing.
- **Auto-discovery of API IDs from CloudFormation stack outputs.** When `provider.apiGateway.restApiId` and `provider.websocketApiId` are not pre-supplied, the plugin reads the `ServiceEndpoint` and `ServiceEndpointWebsocket` outputs that Serverless Framework emits by default. Pre-supplied IDs always take precedence. Services whose APIs are created in the same stack no longer need extra configuration to enable API Gateway integration management.
- Validation of the alias name against AWS Lambda alias and API Gateway stage name rules (alphanumerics, dashes, underscores; up to 128 characters; not `$LATEST`). Invalid names are rejected before any AWS calls are made.
- Documented alias lifecycle semantics: the plugin is non-destructive and does not auto-delete stale API Gateway stages or Lambda aliases; cleanup is manual.

### Changed

- Switched the API Gateway stage variable used for Lambda alias routing from `alias` to `SERVERLESS_ALIAS` to align with existing service integrations.

### Unchanged

- Single-alias deploys (the case where the deploying alias matches `provider.stage`) behave identically to v0.5.0.
- The integration URI continues to use API Gateway stage-variable alias routing and the plugin continues to set the routing stage variable on managed stages.

## [0.5.0] - 2025-09-16

Initial baseline tagged when this fork was created. See upstream releases at
<https://github.com/Castlenine/serverless-aws-alias-v4/releases> for prior history.
