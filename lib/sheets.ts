import 'server-only'
import { resolvePipelineRow, PipelineRowError } from './pipeline-row'
import { google } from 'googleapis'
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID

export async function appendPipelineRow(body: Record<string, unknown>) {
    const {
      brand_name,
      website,
      lead_source,
      revenue_estimate,
      retailers,
      category,
      icp_score,
      score_band,
      signals,
      target_role,
      contact_name,
      email_subject,
      email_body,
      status,
      sent_by
    } = body

    const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT
    if (!serviceAccountRaw) {
      throw new Error('Service account not configured')
    }

    const serviceAccount = JSON.parse(serviceAccountRaw)

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })

    const sheets = google.sheets({ version: 'v4', auth })

    const retailerNames = Array.isArray(retailers)
      ? retailers.map((r: { name: string }) => r.name).join(', ')
      : retailers

    const signalSummary = Array.isArray(signals)
      ? signals.slice(0, 3).map((s: { type: string }) => s.type.replace(/_/g, ' ')).join(', ')
      : signals

    const row = [
      brand_name ?? '',
      website ?? '',
      lead_source ?? 'Outbound',
      revenue_estimate ?? '',
      retailerNames ?? '',
      category ?? '',
      icp_score ?? '',
      score_band ?? '',
      signalSummary ?? '',
      target_role ?? '',
      contact_name ?? '',
      email_subject ?? '',
      email_body ?? '',
      new Date().toLocaleDateString('en-AU'),
      status ?? 'Sent',
      '',
      sent_by ?? ''
    ]

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:Q',
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    })

}

export async function updatePipelineStatus(body: { brand_name?: string; outreach_id?: string; status: string }) {
  if (typeof body.status !== 'string' || !body.status.trim() || body.status.length > 100) throw new Error('Invalid status')
  await updatePipelineCell(body, 'O', body.status)
}
export async function updatePipelineNotes(body: { brand_name?: string; outreach_id?: string; notes: string }) {
  if (typeof body.notes !== 'string' || body.notes.length > 10000) throw new Error('Invalid notes')
  await updatePipelineCell(body, 'P', body.notes)
}
async function updatePipelineCell(body: { brand_name?: string; outreach_id?: string }, column: 'O' | 'P', value: string) {
  const destination = process.env.GOOGLE_SHEETS_ID ?? ''
  const sheets = outreachSheets(destination)
  if (body.outreach_id) {
    if (!/^(outreach:[a-f0-9]{32}|(?:immediate|scheduled):[1-9]\d*)$/.test(body.outreach_id)) throw new Error('Invalid outreach ID')
    const metadata = await sheets.spreadsheets.developerMetadata.search({ spreadsheetId: destination, requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: 'atelier_outreach_id', metadataValue: body.outreach_id, visibility: 'DOCUMENT', locationType: 'ROW' } }] } }, { timeout: 10_000, retry: false })
    const matches = metadata.data.matchedDeveloperMetadata ?? []
    if (matches.length !== 1 || typeof matches[0].developerMetadata?.metadataId !== 'number') throw new PipelineRowError('Outreach row metadata is missing or duplicated. Review Sheets before editing.')
    const result = await sheets.spreadsheets.values.batchUpdateByDataFilter({ spreadsheetId: destination, requestBody: {
      valueInputOption: 'RAW', data: [{ dataFilter: { developerMetadataLookup: { metadataId: matches[0].developerMetadata.metadataId } },
        values: [[...Array(column === 'O' ? 14 : 15).fill(null), value]] }],
    } }, { timeout: 10_000, retry: false })
    if (result.data.totalUpdatedCells !== 1) throw new Error('Pipeline update was not confirmed')
    return
  }
  // Legacy rows have no persistent metadata. Only a unique brand is eligible;
  // operators must avoid structural edits while these legacy writes run.
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: destination, range: 'Sheet1!A:S' }, { timeout: 10_000, retry: false })
  const row = resolvePipelineRow(response.data.values ?? [], body)
  await sheets.spreadsheets.values.update({ spreadsheetId: destination, range: `Sheet1!${column}${row}`, valueInputOption: 'RAW', requestBody: { values: [[value]] } }, { timeout: 10_000, retry: false })
}

function outreachSheets(destination: string) {
  if (!destination || destination !== process.env.GOOGLE_SHEETS_ID) throw new Error('sheets_destination_changed')
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT
  if (!raw) throw new Error('sheets_not_configured')
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  return google.sheets({ version: 'v4', auth })
}

// Columns A:Q keep their existing meanings. Operators reserve R:S with these
// headers before enabling export; occupied unrelated columns fail closed.
export async function findOutreachRow(id: string, destination: string): Promise<string | null> {
  const sheets = outreachSheets(destination)
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: destination, range: 'Sheet1!R:S' }, { timeout: 10_000, retry: false })
  const rows = response.data.values ?? []
  if (rows[0]?.[0] !== 'Outreach ID' || rows[0]?.[1] !== 'Recipient Email') throw new Error('sheets_export_headers_required')
  const matches = rows.flatMap((row, index) => row[0] === id ? [index + 1] : [])
  if (matches.length > 1) throw new Error('duplicate_outreach_id')
  return matches.length === 1 ? `Sheet1!A${matches[0]}:S${matches[0]}` : null
}

export async function appendOutreachRow(body: Record<string, unknown>, id: string, destination: string, acceptedAt: string, beforeWrite: () => Promise<boolean>): Promise<string | null> {
  const sheets = outreachSheets(destination)
  const retailers = Array.isArray(body.retailers) ? body.retailers.map(r => typeof r === 'object' && r ? String(r.name ?? '') : String(r)).join(', ') : body.retailers
  const signals = Array.isArray(body.signals) ? body.signals.slice(0,3).map(s => typeof s === 'object' && s ? String(s.type ?? '').replace(/_/g,' ') : String(s)).join(', ') : body.signals
  const row = [body.brand_name || body.to_email,body.website,body.lead_source,body.revenue_estimate,retailers,body.category,body.icp_score,body.score_band,signals,body.target_role,body.contact_name,body.email_subject,body.email_body,
    new Date(acceptedAt).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' }),'Sent','',body.sent_by,id,body.to_email].map(value => value ?? '')
  const properties = await sheets.spreadsheets.get({ spreadsheetId: destination, fields: 'sheets.properties' }, { timeout: 10_000, retry: false })
  const sheet = properties.data.sheets?.find(sheet => sheet.properties?.title === 'Sheet1')?.properties
  if (typeof sheet?.sheetId !== 'number') throw new Error('Sheet1 missing')
  const current = await sheets.spreadsheets.values.get({ spreadsheetId: destination, range: 'Sheet1!A:S' }, { timeout: 10_000, retry: false })
  if (current.data.values?.[0]?.[17] !== 'Outreach ID' || current.data.values?.[0]?.[18] !== 'Recipient Email') throw new Error('sheets_export_headers_required')
  const index = Math.max(current.data.values?.length ?? 1, 1)
  // Insert a NEW row rather than overwrite a previously empty coordinate. All
  // requests below commit atomically, including metadata that follows row moves.
  if (!await beforeWrite()) return null
  const result = await sheets.spreadsheets.batchUpdate({ spreadsheetId: destination, requestBody: { requests: [
    { appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: 1 } },
    { insertDimension: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 }, inheritFromBefore: index > 1 } },
    { updateCells: { start: { sheetId: sheet.sheetId, rowIndex: index, columnIndex: 0 }, rows: [{ values: row.map(value => ({ userEnteredValue: { stringValue: String(value) } })) }], fields: 'userEnteredValue' } },
    { createDeveloperMetadata: { developerMetadata: { metadataKey: 'atelier_outreach_id', metadataValue: id, visibility: 'DOCUMENT', location: { dimensionRange: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 } } } } },
  ] } }, { timeout: 10_000, retry: false })
  if (typeof result.data.replies?.[3]?.createDeveloperMetadata?.developerMetadata?.metadataId !== 'number') throw new Error('append_unconfirmed')
  return `Sheet1!A${index+1}:S${index+1}`
}
