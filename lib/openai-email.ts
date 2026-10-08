const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = 'gpt-5-mini'

export type OpenAIUsage = {
  inputTokens: number
  outputTokens: number
}

type OpenAIResponse = {
  output?: Array<{
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

function responseText(response: OpenAIResponse): string {
  return (response.output ?? [])
    .flatMap(item => item.content ?? [])
    .filter(content => content.type === 'output_text' && typeof content.text === 'string')
    .map(content => content.text)
    .join('')
}

async function createResponse(input: string, text?: Record<string, unknown>, maxOutputTokens = 1500): Promise<{
  text: string
  usage: OpenAIUsage
}> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OpenAI API key is not configured')

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_EMAIL_MODEL?.trim() || DEFAULT_MODEL,
      input,
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: 'low' },
      ...(text ? { text } : {})
    })
  })

  if (!response.ok) {
    throw new Error(`OpenAI request failed with status ${response.status}`)
  }

  const data = await response.json() as OpenAIResponse
  const output = responseText(data)
  if (!output) throw new Error('OpenAI returned an empty response')

  return {
    text: output,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0
    }
  }
}

export async function generateEmailWithOpenAI(prompt: string): Promise<{
  email: { subject: string; body: string }
  usage: OpenAIUsage
}> {
  const response = await createResponse(prompt, {
    format: {
      type: 'json_schema',
      name: 'outreach_email',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['subject', 'body'],
        additionalProperties: false
      }
    }
  })

  const email = JSON.parse(response.text) as { subject?: unknown; body?: unknown }
  if (typeof email.subject !== 'string' || typeof email.body !== 'string') {
    throw new Error('OpenAI returned an invalid email')
  }

  return { email: { subject: email.subject, body: email.body }, usage: response.usage }
}

export async function generatePitchWithOpenAI(prompt: string): Promise<string> {
  return (await createResponse(prompt, undefined, 300)).text
}
