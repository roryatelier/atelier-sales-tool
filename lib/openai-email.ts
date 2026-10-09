import { generateStructured, generateText, type OpenAIUsage } from './openai'

export type { OpenAIUsage } from './openai'

export async function generateEmailWithOpenAI(prompt: string): Promise<{
  email: { subject: string; body: string }
  usage: OpenAIUsage
}> {
  const response = await generateStructured<{ subject: string; body: string }>({
    prompt,
    purpose: 'email',
    schemaName: 'outreach_email',
    schema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['subject', 'body'],
      additionalProperties: false
    },
    validate: (value): value is { subject: string; body: string } => {
      if (!value || typeof value !== 'object') return false
      const email = value as Record<string, unknown>
      return typeof email.subject === 'string' && email.subject.length > 0 && typeof email.body === 'string' && email.body.length > 0
    },
    maxOutputTokens: 1500,
    maxAttempts: 1
  })
  return { email: response.data, usage: response.usage }
}

export async function generatePitchWithOpenAI(prompt: string): Promise<string> {
  return (await generateText({ prompt, purpose: 'email', maxOutputTokens: 300 })).text
}
