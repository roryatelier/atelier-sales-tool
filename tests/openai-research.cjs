/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const loadTypeScript = require('./load-ts.cjs')

function loadProvider(fetchImpl, env = { OPENAI_API_KEY: 'synthetic-test-key' }) {
  return loadTypeScript('../lib/openai-research.ts', { process: { env }, fetch: fetchImpl, Response })
}

test('research uses OpenAI Responses with required web search and structured output', async () => {
  let request
  const provider = loadProvider(async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ signals: [{ brand: 'Example' }] }) }] }],
      usage: { input_tokens: 120, output_tokens: 30 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const result = await provider.researchWithOpenAI({
    prompt: 'find recent news',
    schemaName: 'signals',
    schema: { type: 'object' },
    validate: value => Boolean(value && Array.isArray(value.signals))
  })

  assert.equal(request.url, 'https://api.openai.com/v1/responses')
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-test-key')
  assert.equal(request.body.model, 'gpt-5-mini')
  assert.equal(request.body.tools[0].type, 'web_search')
  assert.equal(request.body.tool_choice, 'required')
  assert.equal(request.body.text.format.type, 'json_schema')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    data: { signals: [{ brand: 'Example' }] },
    usage: { inputTokens: 120, outputTokens: 30 }
  })
})

test('research errors expose status without leaking provider response content', async () => {
  const provider = loadProvider(async () => new Response('provider-secret-details', { status: 401 }))
  await assert.rejects(
    provider.researchWithOpenAI({ prompt: 'x', schemaName: 'x', schema: { type: 'object' }, validate: () => true }),
    error => error.code === 'provider_authentication' && !error.message.includes('provider-secret-details')
  )
})
