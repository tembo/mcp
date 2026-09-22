const response = { '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } } };
const body = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } };

export const spec = {
  openapi: '3.1.0',
  info: { title: 'Tembo Public API', version: 'test' },
  servers: [{ url: 'https://ignored.example.com' }],
  components: { schemas: { Input: { type: 'object', properties: { content: { type: 'string' }, settings: { type: 'object', additionalProperties: true } }, required: ['content'] } } },
  paths: {
    '/v1/widgets': {
      get: { operationId: 'listWidgets', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: response },
      post: { operationId: 'createWidget', requestBody: body, responses: response },
    },
    '/v1/widgets/{widgetId}': {
      parameters: [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'retrieveWidget', responses: response },
      put: { operationId: 'replaceWidget', requestBody: body, responses: response },
      patch: { operationId: 'updateWidget', requestBody: body, responses: response },
      delete: { operationId: 'deleteWidget', parameters: [{ name: 'force', in: 'query', schema: { type: 'boolean' } }], requestBody: body, responses: response },
    },
    '/v1/billing': { get: { operationId: 'retrieveBilling', responses: response } },
    '/v1/api-keys': { post: { operationId: 'createApiKey', requestBody: body, responses: response } },
    '/session/create': { post: { operationId: 'createLegacySession', requestBody: body, responses: response } },
    '/v1/future-endpoint': { get: { operationId: 'futureEndpoint', responses: response } },
  },
};
