/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadProvider(fetchImpl, env = { OPENAI_API_KEY: 'synthetic-test-key' }) {
  const filename = path.resolve(__dirname, '../lib/openai-email.ts')
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  vm.runInNewContext(source, { exports, process: { env }, fetch: fetchImpl }, { filename })
  return exports
}

test('email drafts use OpenAI Responses structured output', async () => {
  let request
  const provider = loadProvider(async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ subject: 'Atelier x Brand', body: 'Hi Samara, Brand is growing.' }) }] }],
      usage: { input_tokens: 42, output_tokens: 18 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const result = await provider.generateEmailWithOpenAI('draft prompt')
  assert.equal(request.url, 'https://api.openai.com/v1/responses')
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-test-key')
  assert.equal(request.body.model, 'gpt-5-mini')
  assert.equal(request.body.text.format.type, 'json_schema')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    email: { subject: 'Atelier x Brand', body: 'Hi Samara, Brand is growing.' },
    usage: { inputTokens: 42, outputTokens: 18 }
  })
})

test('provider errors expose status without leaking response content', async () => {
  const provider = loadProvider(async () => new Response('provider-secret-details', { status: 401 }))
  await assert.rejects(
    provider.generateEmailWithOpenAI('draft prompt'),
    error => error.message === 'OpenAI request failed with status 401' && !error.message.includes('provider-secret-details')
  )
})
