const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = 'gpt-5-mini'

export type OpenAIResearchUsage = {
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

export async function researchWithOpenAI<T>(options: {
  prompt: string
  schemaName: string
  schema: Record<string, unknown>
  maxOutputTokens?: number
}): Promise<{ data: T; usage: OpenAIResearchUsage }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OpenAI API key is not configured')

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_RESEARCH_MODEL?.trim() || DEFAULT_MODEL,
      input: options.prompt,
      max_output_tokens: options.maxOutputTokens ?? 4000,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      tool_choice: 'required',
      text: {
        format: {
          type: 'json_schema',
          name: options.schemaName,
          strict: true,
          schema: options.schema
        }
      }
    })
  })

  if (!response.ok) {
    throw new Error(`OpenAI research request failed with status ${response.status}`)
  }

  const responseData = await response.json() as OpenAIResponse
  const output = responseText(responseData)
  if (!output) throw new Error('OpenAI research returned an empty response')

  let data: T
  try {
    data = JSON.parse(output) as T
  } catch {
    throw new Error('OpenAI research returned malformed JSON')
  }

  return {
    data,
    usage: {
      inputTokens: responseData.usage?.input_tokens ?? 0,
      outputTokens: responseData.usage?.output_tokens ?? 0
    }
  }
}
