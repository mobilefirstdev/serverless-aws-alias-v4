'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { awsError, callsTo, createPlugin, notFound } = require('./helpers.js');

const REST = { apiGateway: { restApiId: 'rest123' } };
const WEBSOCKET = { websocketApiId: 'ws456' };

const opsByPath = (patchOperations) => Object.fromEntries(patchOperations.map((op) => [op.path, op.value]));

test('extractApiIdFromEndpointUrl parses the standard Serverless endpoint outputs', () => {
	const { plugin } = createPlugin();

	assert.equal(plugin.extractApiIdFromEndpointUrl('https://abc123.execute-api.us-east-1.amazonaws.com/dev'), 'abc123');
	assert.equal(plugin.extractApiIdFromEndpointUrl('wss://ws456.execute-api.eu-west-1.amazonaws.com/prod'), 'ws456');
	assert.equal(plugin.extractApiIdFromEndpointUrl('https://example.com/dev'), null);
	assert.equal(plugin.extractApiIdFromEndpointUrl(undefined), null);
});

test('validateConfiguration rejects alias names AWS would refuse', () => {
	for (const name of ['$LATEST', '123', 'a.b', 'has space', 'x'.repeat(129)]) {
		const { plugin } = createPlugin({ custom: { alias: { name } } });
		assert.throws(() => plugin.validateConfiguration(), /Invalid alias name/, name);
	}

	for (const name of ['rc', 'feature-x_1', 'v2']) {
		const { plugin } = createPlugin({ custom: { alias: { name } } });
		assert.doesNotThrow(() => plugin.validateConfiguration(), name);
	}
});

test('discoverApiIdsFromStack fills in missing IDs from stack outputs and keeps pre-supplied ones', async () => {
	const outputs = [
		{ OutputKey: 'ServiceEndpoint', OutputValue: 'https://discovered.execute-api.us-east-1.amazonaws.com/dev' },
		{ OutputKey: 'ServiceEndpointWebsocket', OutputValue: 'wss://wsdiscovered.execute-api.us-east-1.amazonaws.com/dev' },
	];
	const handlers = { 'CloudFormation.describeStacks': () => ({ Stacks: [{ Outputs: outputs }] }) };

	const fresh = createPlugin({ handlers });
	await fresh.plugin.discoverApiIdsFromStack();
	assert.equal(fresh.plugin.config.restApiId, 'discovered');
	assert.equal(fresh.plugin.config.websocketApiId, 'wsdiscovered');
	assert.equal(fresh.calls[0].params.StackName, 'service-dev');

	const preset = createPlugin({ handlers, providerConfig: REST });
	await preset.plugin.discoverApiIdsFromStack();
	assert.equal(preset.plugin.config.restApiId, 'rest123');
	assert.equal(preset.plugin.config.websocketApiId, 'wsdiscovered');

	const both = createPlugin({ handlers, providerConfig: { ...REST, ...WEBSOCKET } });
	await both.plugin.discoverApiIdsFromStack();
	assert.equal(both.calls.length, 0);
});

test('discoverApiIdsFromStack is a no-op when the stack does not exist yet', async () => {
	const { plugin } = createPlugin({
		handlers: {
			'CloudFormation.describeStacks': () => {
				throw awsError('Stack does not exist', 'ValidationError');
			},
		},
	});

	await plugin.discoverApiIdsFromStack();

	assert.equal(plugin.config.restApiId, undefined);
	assert.equal(plugin.config.websocketApiId, undefined);
});

test('deployApiGateway with alias == stage manages only the framework stage', async () => {
	const { plugin, calls } = createPlugin({
		stage: 'dev',
		providerConfig: REST,
		handlers: {
			'APIGateway.createDeployment': () => ({ id: 'dep1' }),
			'APIGateway.updateStage': () => ({}),
		},
	});

	await plugin.deployApiGateway();

	assert.equal(callsTo(calls, 'createDeployment')[0].params.stageName, 'dev');
	const UPDATES = callsTo(calls, 'updateStage');
	assert.equal(UPDATES.length, 1);
	assert.equal(UPDATES[0].params.stageName, 'dev');
	const OPS = opsByPath(UPDATES[0].params.patchOperations);
	assert.equal(OPS['/variables/alias'], 'dev');
	assert.equal('/deploymentId' in OPS, false);
});

test('deployApiGateway with alias != stage creates the alias stage and refreshes the framework stage', async () => {
	const { plugin, calls } = createPlugin({
		stage: 'prod',
		custom: { alias: { name: 'rc' } },
		providerConfig: REST,
		handlers: {
			'APIGateway.createDeployment': () => ({ id: 'dep2' }),
			'APIGateway.updateStage': () => ({}),
		},
	});

	await plugin.deployApiGateway();

	assert.equal(callsTo(calls, 'createDeployment')[0].params.stageName, 'rc');
	const UPDATES = callsTo(calls, 'updateStage');
	assert.equal(UPDATES.length, 2);

	const RC = opsByPath(UPDATES.find((call) => call.params.stageName === 'rc').params.patchOperations);
	assert.equal(RC['/variables/alias'], 'rc');
	assert.equal('/deploymentId' in RC, false);

	const PROD = opsByPath(UPDATES.find((call) => call.params.stageName === 'prod').params.patchOperations);
	assert.equal(PROD['/deploymentId'], 'dep2');
	assert.equal(PROD['/variables/alias'], 'prod');
});

test('deployApiGateway tolerates a missing framework stage', async () => {
	const { plugin } = createPlugin({
		stage: 'prod',
		custom: { alias: { name: 'rc' } },
		providerConfig: REST,
		handlers: {
			'APIGateway.createDeployment': () => ({ id: 'dep3' }),
			'APIGateway.updateStage': (params) => {
				if (params.stageName === 'prod') throw notFound('NotFoundException');
				return {};
			},
		},
	});

	await assert.doesNotReject(plugin.deployApiGateway());
});

test('deployWebSocketApi creates a missing alias stage and updates the existing framework stage', async () => {
	const { plugin, calls } = createPlugin({
		stage: 'prod',
		custom: { alias: { name: 'rc' } },
		providerConfig: WEBSOCKET,
		handlers: {
			'ApiGatewayV2.createDeployment': () => ({ DeploymentId: 'wsdep1' }),
			'ApiGatewayV2.getStage': (params) => {
				if (params.StageName === 'rc') throw notFound('NotFoundException');
				return {};
			},
			'ApiGatewayV2.createStage': () => ({}),
			'ApiGatewayV2.updateStage': () => ({}),
		},
	});

	await plugin.deployWebSocketApi();

	const CREATES = callsTo(calls, 'createStage');
	assert.equal(CREATES.length, 1);
	assert.equal(CREATES[0].params.StageName, 'rc');
	assert.equal(CREATES[0].params.DeploymentId, 'wsdep1');
	assert.equal(CREATES[0].params.StageVariables.alias, 'rc');

	const UPDATES = callsTo(calls, 'updateStage');
	assert.equal(UPDATES.length, 1);
	assert.equal(UPDATES[0].params.StageName, 'prod');
	assert.equal(UPDATES[0].params.DeploymentId, 'wsdep1');
	assert.equal(UPDATES[0].params.StageVariables.alias, 'prod');
});

test('deployWebSocketApi with alias == stage touches a single stage', async () => {
	const { plugin, calls } = createPlugin({
		stage: 'dev',
		providerConfig: WEBSOCKET,
		handlers: {
			'ApiGatewayV2.createDeployment': () => ({ DeploymentId: 'wsdep2' }),
			'ApiGatewayV2.getStage': () => ({}),
			'ApiGatewayV2.updateStage': () => ({}),
		},
	});

	await plugin.deployWebSocketApi();

	assert.equal(callsTo(calls, 'createStage').length, 0);
	const UPDATES = callsTo(calls, 'updateStage');
	assert.equal(UPDATES.length, 1);
	assert.equal(UPDATES[0].params.StageName, 'dev');
	assert.equal(UPDATES[0].params.StageVariables.alias, 'dev');
});
