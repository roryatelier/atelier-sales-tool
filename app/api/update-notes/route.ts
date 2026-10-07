import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const body = await request.json()
    const { brand_name, notes } = body

    const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT
    if (!serviceAccountRaw) return NextResponse.json({ error: 'Service account not configured' }, { status: 500 })

    const serviceAccount = JSON.parse(serviceAccountRaw)
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })

    const sheets = google.sheets({ version: 'v4', auth })

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:A'
    })

    const rows = response.data.values ?? []
    const rowIndex = rows.findIndex(row => row[0]?.toLowerCase() === brand_name?.toLowerCase())

    if (rowIndex === -1) return NextResponse.json({ error: 'Brand not found' }, { status: 404 })

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!P${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[notes]] }
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logSafeError('Update notes error:', error)
    return NextResponse.json({ error: 'Failed to update notes' }, { status: 500 })
  }
}