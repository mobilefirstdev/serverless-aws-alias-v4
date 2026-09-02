'use strict';

const Plugin = require('../src/index.js');

const SERVICES = ['Lambda', 'APIGateway', 'ApiGatewayV2', 'CloudFormation', 'STS'];

function awsError(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}

const throttled = () => awsError('Rate exceeded', 'TooManyRequestsException');
const notFound = (code = 'ResourceNotFoundException') => awsError('Not found', code);

/**
 * Fake `provider.sdk` in the aws-sdk v2 shape: `new sdk.Lambda().getAlias(params).promise()`.
 * Every call is answered by `handlers['Service.method'](params)` and recorded in `calls`.
 */
function createStubSdk(handlers, calls) {
	const sdk = {};

	for (const service of SERVICES) {
		sdk[service] = function StubClient() {
			return new Proxy(
				{},
				{
					get(_target, method) {
						if (typeof method !== 'string') return undefined;

						return (params) => ({
							promise: async () => {
								calls.push({ service, method, params });
								const handler = handlers[`${service}.${method}`];
								if (!handler) throw new Error(`No stub for ${service}.${method}`);
								return handler(params);
							},
						});
					},
				},
			);
		};
	}

	return sdk;
}

function createPlugin({ handlers = {}, stage = 'dev', custom = {}, functions = {}, providerConfig = {} } = {}) {
	const calls = [];
	const logs = [];
	const awsProvider = {
		sdk: createStubSdk(handlers, calls),
		getRegion: () => 'us-east-1',
		getStage: () => stage,
		naming: {
			getStackName: () => `service-${stage}`,
			getLambdaLogicalId: (name) => `${name}LambdaFunction`,
		},
	};
	const serverless = {
		getProvider: () => awsProvider,
		service: { provider: { stage, ...providerConfig }, functions, custom },
		cli: { log: (message) => logs.push(message) },
		classes: { Error },
	};

	const plugin = new Plugin(serverless);
	plugin.sleep = async () => {};
	plugin.initializePlugin();

	return { plugin, calls, logs };
}

const callsTo = (calls, method) => calls.filter((call) => call.method === method);

module.exports = { awsError, callsTo, createPlugin, notFound, throttled };
