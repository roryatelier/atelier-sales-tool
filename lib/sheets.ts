import 'server-only'
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

export async function updatePipelineStatus(body: { brand_name: string; status: string }) {
    const { brand_name, status } = body

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

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:O'
    })

    const rows = response.data.values ?? []

    const rowIndex = rows.findIndex(row => row[0]?.toLowerCase() === brand_name?.toLowerCase())

    if (rowIndex === -1) {
      throw new Error('Brand not found in pipeline')
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!O${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] }
    })

}
