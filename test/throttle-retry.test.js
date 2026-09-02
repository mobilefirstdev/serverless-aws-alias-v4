'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { awsError, callsTo, createPlugin, notFound, throttled } = require('./helpers.js');

const FUNCTION = { name: 'hello', functionName: 'svc-dev-hello', environment: { A: '1' }, events: [], description: '' };

const configuration = (overrides = {}) => ({
	Configuration: {
		FunctionName: 'svc-dev-hello',
		CodeSha256: 'abc',
		Handler: 'index.handler',
		Runtime: 'nodejs20.x',
		MemorySize: 128,
		Timeout: 6,
		Environment: { Variables: { A: '1' } },
		LastUpdateStatus: 'Successful',
		...overrides,
	},
});

test('retryOnThrottle retries throttling errors and returns the eventual result', async () => {
	const { plugin } = createPlugin();
	let attempts = 0;

	const result = await plugin.retryOnThrottle('stub', async () => {
		attempts++;
		if (attempts < 3) throw throttled();
		return 'ok';
	});

	assert.equal(result, 'ok');
	assert.equal(attempts, 3);
});

test('retryOnThrottle gives up after the retry budget', async () => {
	const { plugin } = createPlugin();
	let attempts = 0;

	await assert.rejects(
		plugin.retryOnThrottle('stub', async () => {
			attempts++;
			throw throttled();
		}),
		/Rate exceeded/,
	);

	assert.equal(attempts, 9); // one initial attempt plus eight retries
});

test('retryOnThrottle rethrows non-throttling errors immediately', async () => {
	const { plugin } = createPlugin();
	let attempts = 0;

	await assert.rejects(
		plugin.retryOnThrottle('stub', async () => {
			attempts++;
			throw notFound();
		}),
		(error) => error.code === 'ResourceNotFoundException',
	);

	assert.equal(attempts, 1);
});

test('isThrottlingError recognizes SDK v2 codes, SDK v3 names and bare messages', () => {
	const { plugin } = createPlugin();

	assert.equal(plugin.isThrottlingError(awsError('x', 'ThrottlingException')), true);
	assert.equal(plugin.isThrottlingError(Object.assign(new Error('x'), { name: 'TooManyRequestsException' })), true);
	assert.equal(plugin.isThrottlingError(new Error('Rate exceeded')), true);
	assert.equal(plugin.isThrottlingError(notFound()), false);
	assert.equal(plugin.isThrottlingError(null), false);
});

test('getSdkClient constructs one client per service per deploy', () => {
	const { plugin } = createPlugin();

	assert.equal(plugin.getSdkClient('Lambda'), plugin.getSdkClient('Lambda'));
	assert.notEqual(plugin.getSdkClient('Lambda'), plugin.getSdkClient('APIGateway'));
});

test('publishNewFunctionVersion skips updateFunctionConfiguration when the live environment already matches', async () => {
	const { plugin, calls } = createPlugin({
		handlers: {
			'Lambda.getFunction': () => configuration(),
			'Lambda.publishVersion': () => ({ Version: '7' }),
		},
	});

	const version = await plugin.publishNewFunctionVersion(FUNCTION);

	assert.equal(version, '7');
	assert.equal(callsTo(calls, 'updateFunctionConfiguration').length, 0);
	assert.equal(callsTo(calls, 'publishVersion').length, 1);
});

test('publishNewFunctionVersion updates the configuration first when the environment drifted', async () => {
	const { plugin, calls } = createPlugin({
		handlers: {
			'Lambda.getFunction': () => configuration({ Environment: { Variables: { A: 'stale' } } }),
			'Lambda.updateFunctionConfiguration': () => ({}),
			'Lambda.publishVersion': () => ({ Version: '8' }),
		},
	});

	const version = await plugin.publishNewFunctionVersion(FUNCTION);

	assert.equal(version, '8');
	const UPDATES = callsTo(calls, 'updateFunctionConfiguration');
	assert.equal(UPDATES.length, 1);
	assert.deepEqual(UPDATES[0].params.Environment.Variables, { A: '1' });
});

test('publishNewFunctionVersion waits out an in-progress update before publishing', async () => {
	let reads = 0;
	const { plugin, calls } = createPlugin({
		handlers: {
			'Lambda.getFunction': () => {
				reads++;
				return configuration({ LastUpdateStatus: reads < 3 ? 'InProgress' : 'Successful' });
			},
			'Lambda.publishVersion': () => ({ Version: '9' }),
		},
	});

	assert.equal(await plugin.publishNewFunctionVersion(FUNCTION), '9');
	assert.equal(callsTo(calls, 'updateFunctionConfiguration').length, 0);
	assert.ok(reads >= 3);
});

test('createOrUpdateFunctionAliases creates the alias from a throttled-then-recovered lookup', async () => {
	let aliasLookups = 0;
	const { plugin, calls } = createPlugin({
		handlers: {
			'Lambda.getAlias': () => {
				aliasLookups++;
				if (aliasLookups <= 2) throw throttled();
				throw notFound();
			},
			'Lambda.getFunction': () => configuration(),
			'Lambda.listVersionsByFunction': () => ({ Versions: [{ Version: '$LATEST' }, { Version: '3' }] }),
			'Lambda.createAlias': (params) => ({ AliasArn: `arn:alias:${params.Name}`, FunctionVersion: params.FunctionVersion }),
		},
	});

	const created = await plugin.createOrUpdateFunctionAliases([FUNCTION]);

	assert.equal(created.length, 1);
	assert.equal(created[0].version, '3');
	const CREATES = callsTo(calls, 'createAlias');
	assert.equal(CREATES.length, 1);
	assert.equal(CREATES[0].params.Name, 'dev');
	assert.equal(CREATES[0].params.FunctionVersion, '3');
	assert.equal(callsTo(calls, 'updateAlias').length, 0);
});

test('createOrUpdateFunctionAliases fails the deploy when a function cannot be processed', async () => {
	const { plugin } = createPlugin({
		handlers: {
			'Lambda.getAlias': () => {
				throw awsError('boom', 'ServiceException');
			},
		},
	});

	await assert.rejects(plugin.createOrUpdateFunctionAliases([FUNCTION]), /Failed to process aliases for 1 function\(s\): svc-dev-hello/);
});

test('createOrUpdateFunctionAliases fails the deploy on a persistent throttle instead of guessing', async () => {
	const { plugin, calls } = createPlugin({
		handlers: {
			'Lambda.getAlias': () => {
				throw throttled();
			},
		},
	});

	await assert.rejects(plugin.createOrUpdateFunctionAliases([FUNCTION]), /Failed to process aliases/);
	assert.equal(callsTo(calls, 'getAlias').length, 9);
	assert.equal(callsTo(calls, 'publishVersion').length, 0);
});

test('failOnAliasError: false restores warn-and-continue', async () => {
	const { plugin, logs } = createPlugin({
		custom: { alias: { failOnAliasError: false } },
		handlers: {
			'Lambda.getAlias': () => {
				throw awsError('boom', 'ServiceException');
			},
		},
	});

	const created = await plugin.createOrUpdateFunctionAliases([FUNCTION]);

	assert.deepEqual(created, []);
	assert.ok(logs.some((line) => line.includes('WARNING: Failed to process aliases for 1 functions')));
});
