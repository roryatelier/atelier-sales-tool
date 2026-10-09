import { researchStructured, type OpenAIUsage } from './openai'

export type OpenAIResearchUsage = OpenAIUsage

export async function researchWithOpenAI<T>(options: {
  prompt: string
  schemaName: string
  schema: Record<string, unknown>
  validate: (value: unknown) => value is T
  maxOutputTokens?: number
}): Promise<{ data: T; usage: OpenAIResearchUsage }> {
  const response = await researchStructured<T>({
    prompt: options.prompt,
    schemaName: options.schemaName,
    schema: options.schema,
    validate: options.validate,
    maxOutputTokens: options.maxOutputTokens
  })
  return { data: response.data, usage: response.usage }
}
