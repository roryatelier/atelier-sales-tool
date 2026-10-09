import 'server-only'

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = 'gpt-5-mini'

export type ProviderErrorCode =
  | 'provider_configuration'
  | 'provider_authentication'
  | 'provider_rate_limit'
  | 'provider_timeout'
  | 'provider_response_invalid'
  | 'provider_unavailable'

export type OpenAIUsage = {
  inputTokens: number
  outputTokens: number
}

type ProviderPurpose = 'email' | 'research' | 'general'

type OpenAIResponse = {
  id?: string
  status?: string
  incomplete_details?: { reason?: string }
  output?: Array<{
    type?: string
    content?: Array<{
      type?: string
      text?: string
      refusal?: string
    }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly httpStatus: number
  readonly retryable: boolean
  readonly requestId: string

  constructor(code: ProviderErrorCode, httpStatus: number, retryable: boolean, requestId: string) {
    super(code)
    this.name = 'ProviderError'
    this.code = code
    this.httpStatus = httpStatus
    this.retryable = retryable
    this.requestId = requestId
  }
}

export function publicProviderError(error: unknown): {
  body: { error: { code: ProviderErrorCode; message: string; request_id: string; retryable: boolean } }
  status: number
} {
  const providerError = error instanceof ProviderError
    ? error
    : new ProviderError('provider_unavailable', 503, true, crypto.randomUUID())
  const messages: Record<ProviderErrorCode, string> = {
    provider_configuration: 'AI service configuration needs administrator attention.',
    provider_authentication: 'AI service configuration needs administrator attention.',
    provider_rate_limit: 'AI service is busy. Try again shortly.',
    provider_timeout: 'Research did not complete. Retry this request.',
    provider_response_invalid: 'AI research returned an invalid result. Retry this request.',
    provider_unavailable: 'AI service is temporarily unavailable. Retry this request.'
  }
  return {
    body: {
      error: {
        code: providerError.code,
        message: messages[providerError.code],
        request_id: providerError.requestId,
        retryable: providerError.retryable
      }
    },
    status: providerError.httpStatus
  }
}

function responseText(response: OpenAIResponse): string {
  return (response.output ?? [])
    .flatMap(item => item.content ?? [])
    .filter(content => content.type === 'output_text' && typeof content.text === 'string')
    .map(content => content.text)
    .join('')
}

function modelFor(purpose: ProviderPurpose): string {
  if (purpose === 'email' && process.env.OPENAI_EMAIL_MODEL?.trim()) return process.env.OPENAI_EMAIL_MODEL.trim()
  if (purpose === 'research' && process.env.OPENAI_RESEARCH_MODEL?.trim()) return process.env.OPENAI_RESEARCH_MODEL.trim()
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL
}

function classifyStatus(status: number, requestId: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('provider_authentication', 503, false, requestId)
  if (status === 429) return new ProviderError('provider_rate_limit', 503, true, requestId)
  if (status >= 500) return new ProviderError('provider_unavailable', 503, true, requestId)
  return new ProviderError('provider_response_invalid', 502, false, requestId)
}

async function waitForRetry(attempt: number, deadlineAt: number) {
  const delay = Math.min(250 * (attempt + 1), Math.max(0, deadlineAt - Date.now()))
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
}

async function createResponse(options: {
  input: string
  purpose?: ProviderPurpose
  text?: Record<string, unknown>
  maxOutputTokens: number
  webSearch?: boolean
  maxAttempts?: 1 | 2
}): Promise<{ text: string; usage: OpenAIUsage; requestId: string }> {
  const requestId = crypto.randomUUID()
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new ProviderError('provider_configuration', 503, false, requestId)

  const webSearch = options.webSearch === true
  const perAttemptMs = webSearch ? 40_000 : 20_000
  const totalMs = webSearch ? 60_000 : 40_000
  const deadlineAt = Date.now() + totalMs
  const maxAttempts = options.maxAttempts ?? 2
  let lastError: ProviderError | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) throw new ProviderError('provider_timeout', 504, true, requestId)
    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': requestId
        },
        signal: AbortSignal.timeout(Math.min(perAttemptMs, remainingMs)),
        body: JSON.stringify({
          model: modelFor(options.purpose ?? 'general'),
          input: options.input,
          max_output_tokens: options.maxOutputTokens,
          reasoning: { effort: 'low' },
          ...(webSearch ? {
            tools: [{ type: 'web_search', search_context_size: 'medium' }],
            tool_choice: 'required'
          } : {}),
          ...(options.text ? { text: options.text } : {})
        })
      })

      if (!response.ok) {
        lastError = classifyStatus(response.status, requestId)
        if (lastError.retryable && attempt + 1 < maxAttempts) {
          await waitForRetry(attempt, deadlineAt)
          continue
        }
        throw lastError
      }

      const data = await response.json() as OpenAIResponse
      if (data.status === 'incomplete' || data.incomplete_details?.reason) {
        throw new ProviderError('provider_response_invalid', 502, false, requestId)
      }
      const refused = (data.output ?? []).some(item =>
        (item.content ?? []).some(content => content.type === 'refusal' || typeof content.refusal === 'string')
      )
      if (refused) throw new ProviderError('provider_response_invalid', 502, false, requestId)
      const output = responseText(data)
      if (!output) throw new ProviderError('provider_response_invalid', 502, false, requestId)

      return {
        text: output,
        requestId,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      lastError = new ProviderError(isTimeout ? 'provider_timeout' : 'provider_unavailable', isTimeout ? 504 : 503, true, requestId)
      if (attempt + 1 < maxAttempts) {
        await waitForRetry(attempt, deadlineAt)
        continue
      }
      throw lastError
    }
  }

  throw lastError ?? new ProviderError('provider_unavailable', 503, true, requestId)
}

export async function generateText(options: {
  prompt: string
  purpose?: ProviderPurpose
  maxOutputTokens?: number
  maxAttempts?: 1 | 2
}): Promise<{ text: string; usage: OpenAIUsage; requestId: string }> {
  return createResponse({
    input: options.prompt,
    purpose: options.purpose,
    maxOutputTokens: options.maxOutputTokens ?? 500,
    maxAttempts: options.maxAttempts
  })
}

export async function generateStructured<T>(options: {
  prompt: string
  purpose?: ProviderPurpose
  schemaName: string
  schema: Record<string, unknown>
  validate: (value: unknown) => value is T
  maxOutputTokens?: number
  maxAttempts?: 1 | 2
  webSearch?: boolean
}): Promise<{ data: T; usage: OpenAIUsage; requestId: string }> {
  const response = await createResponse({
    input: options.prompt,
    purpose: options.purpose,
    maxOutputTokens: options.maxOutputTokens ?? 1500,
    maxAttempts: options.maxAttempts,
    webSearch: options.webSearch,
    text: {
      format: {
        type: 'json_schema',
        name: options.schemaName,
        strict: true,
        schema: options.schema
      }
    }
  })

  let value: unknown
  try {
    value = JSON.parse(response.text)
  } catch {
    throw new ProviderError('provider_response_invalid', 502, false, response.requestId)
  }
  if (!options.validate(value)) {
    throw new ProviderError('provider_response_invalid', 502, false, response.requestId)
  }
  return { data: value, usage: response.usage, requestId: response.requestId }
}

export async function researchStructured<T>(options: Omit<Parameters<typeof generateStructured<T>>[0], 'webSearch'>) {
  return generateStructured<T>({ ...options, purpose: options.purpose ?? 'research', webSearch: true })
}
