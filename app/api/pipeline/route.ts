import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextResponse } from 'next/server'
import { google } from 'googleapis'

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID
const spreadsheetUrl = SPREADSHEET_ID
  ? `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`
  : null

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT
    if (!serviceAccountRaw) {
      return NextResponse.json({ error: 'Service account not configured' }, { status: 500 })
    }

    const serviceAccount = JSON.parse(serviceAccountRaw)

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    })

    const sheets = google.sheets({ version: 'v4', auth })

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:Q'
    })

    const rows = response.data.values ?? []

    if (rows.length <= 1) {
      return NextResponse.json({ success: true, leads: [], sheet_url: spreadsheetUrl })
    }

    const leads = rows.slice(1)
      .filter(row => {
        const name = (row[0] ?? '').trim()
        return name !== '' && name !== 'Brand Name' && name !== 'brand_name'
      })
      .map(row => ({
      brand_name: row[0] ?? '',
      website: row[1] ?? '',
      lead_source: row[2] ?? '',
      revenue_estimate: row[3] ?? '',
      retailers: row[4] ?? '',
      category: row[5] ?? '',
      icp_score: row[6] ?? '',
      score_band: row[7] ?? '',
      key_signals: row[8] ?? '',
      target_role: row[9] ?? '',
      contact_name: row[10] ?? '',
      email_subject: row[11] ?? '',
      email_body: row[12] ?? '',
      date_added: row[13] ?? '',
      status: row[14] ?? '',
      notes: row[15] ?? '',
      sent_by: row[16] ?? ''
    }))

    return NextResponse.json({ success: true, leads: leads.reverse(), sheet_url: spreadsheetUrl })

  } catch (error) {
    logSafeError('Pipeline fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch pipeline' }, { status: 500 })
  }
}
