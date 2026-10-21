export class PipelineRowError extends Error {}
export function resolvePipelineRow(rows: unknown[][], input: { outreach_id?: unknown; brand_name?: unknown }): number {
  if (input.outreach_id !== undefined && input.outreach_id !== '') {
    if (typeof input.outreach_id !== 'string' || !/^(outreach:[a-f0-9]{32}|(?:immediate|scheduled):[1-9]\d*)$/.test(input.outreach_id) || rows[0]?.[17] !== 'Outreach ID') throw new PipelineRowError('Invalid outreach ID or pipeline headers')
    const matches = rows.flatMap((row, index) => index > 0 && row[17] === input.outreach_id ? [index + 1] : [])
    if (matches.length !== 1) throw new PipelineRowError('Outreach ID is missing or duplicated. Review Sheets before editing.')
    return matches[0]
  }
  if (typeof input.brand_name !== 'string' || !input.brand_name.trim()) throw new PipelineRowError('A pipeline entry is required')
  const matches = rows.flatMap((row, index) => index > 0 && String(row[0] ?? '').trim().toLowerCase() === String(input.brand_name).trim().toLowerCase() ? [index + 1] : [])
  if (matches.length !== 1) throw new PipelineRowError('This brand is missing or has multiple entries. Select an outreach entry or review legacy rows in Sheets.')
  return matches[0]
}
