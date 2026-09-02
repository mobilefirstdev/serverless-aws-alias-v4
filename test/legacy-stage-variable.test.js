'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { callsTo, createPlugin, notFound } = require('./helpers.js');

const opsByPath = (patchOperations) => Object.fromEntries(patchOperations.map((op) => [op.path, op.value]));

test('REST stage receives both alias and SERVERLESS_ALIAS variables', async () => {
	const { plugin, calls } = createPlugin({
		stage: 'prod',
		custom: { alias: { name: 'rc' } },
		providerConfig: { apiGateway: { restApiId: 'rest123' } },
		handlers: {
			'APIGateway.createDeployment': () => ({ id: 'dep1' }),
			'APIGateway.updateStage': () => ({}),
		},
	});

	await plugin.deployApiGateway();

	const UPDATES = callsTo(calls, 'updateStage');
	assert.equal(UPDATES.length, 1);
	assert.equal(UPDATES[0].params.stageName, 'prod');
	assert.deepEqual(opsByPath(UPDATES[0].params.patchOperations), {
		'/variables/alias': 'rc',
		'/variables/SERVERLESS_ALIAS': 'rc',
	});
});

test('WebSocket stage receives both alias and SERVERLESS_ALIAS variables on update and create', async () => {
	const handlers = {
		'ApiGatewayV2.createDeployment': () => ({ DeploymentId: 'wsdep1' }),
		'ApiGatewayV2.getStage': () => ({}),
		'ApiGatewayV2.createStage': () => ({}),
		'ApiGatewayV2.updateStage': () => ({}),
	};

	const existing = createPlugin({ stage: 'dev', providerConfig: { websocketApiId: 'ws456' }, handlers });
	await existing.plugin.deployWebSocketApi();
	assert.deepEqual(callsTo(existing.calls, 'updateStage')[0].params.StageVariables, {
		alias: 'dev',
		SERVERLESS_ALIAS: 'dev',
	});

	const missing = createPlugin({
		stage: 'dev',
		providerConfig: { websocketApiId: 'ws456' },
		handlers: {
			...handlers,
			'ApiGatewayV2.getStage': () => {
				throw notFound('NotFoundException');
			},
		},
	});
	await missing.plugin.deployWebSocketApi();
	assert.deepEqual(callsTo(missing.calls, 'createStage')[0].params.StageVariables, {
		alias: 'dev',
		SERVERLESS_ALIAS: 'dev',
	});
});
