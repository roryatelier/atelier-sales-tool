/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const loadTypeScript = require('./load-ts.cjs')

function load(fetchImpl, env = { OPENAI_API_KEY: 'synthetic-test-key' }) {
  return loadTypeScript('../lib/openai.ts', { process: { env }, fetch: fetchImpl, Response })
}

function success(text) {
  return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200 })
}

test('missing API key fails without calling the provider', async () => {
  let calls = 0
  const provider = load(async () => { calls++; return success('never') }, {})
  await assert.rejects(provider.generateText({ prompt: 'x' }), error => error.code === 'provider_configuration' && error.retryable === false)
  assert.equal(calls, 0)
})

test('valid JSON with the wrong domain shape is rejected', async () => {
  const provider = load(async () => success(JSON.stringify({ items: [] })))
  await assert.rejects(provider.generateStructured({
    prompt: 'x', schemaName: 'x', schema: { type: 'object' }, validate: value => Array.isArray(value.signals)
  }), error => error.code === 'provider_response_invalid')
})

test('malformed, empty and refused outputs are rejected', async () => {
  const malformed = load(async () => success('{bad json'))
  await assert.rejects(malformed.generateStructured({ prompt: 'x', schemaName: 'x', schema: { type: 'object' }, validate: () => true }), error => error.code === 'provider_response_invalid')
  for (const response of [success(''), new Response(JSON.stringify({ output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] }), { status: 200 })]) {
    const provider = load(async () => response)
    await assert.rejects(provider.generateText({ prompt: 'x', maxAttempts: 1 }), error => error.code === 'provider_response_invalid')
  }
})

test('429 retries once and then succeeds', async () => {
  let calls = 0
  const provider = load(async () => ++calls === 1 ? new Response('', { status: 429 }) : success('ok'))
  assert.equal((await provider.generateText({ prompt: 'x' })).text, 'ok')
  assert.equal(calls, 2)
})

test('authentication and public errors do not expose provider response content', async () => {
  const provider = load(async () => new Response('secret provider details', { status: 401 }))
  let thrown
  try { await provider.generateText({ prompt: 'x' }) } catch (error) { thrown = error }
  assert.equal(thrown.code, 'provider_authentication')
  const failure = provider.publicProviderError(thrown)
  assert.equal(failure.status, 503)
  assert.equal(failure.body.error.code, 'provider_authentication')
  assert.doesNotMatch(JSON.stringify(failure), /secret provider details/)
})
