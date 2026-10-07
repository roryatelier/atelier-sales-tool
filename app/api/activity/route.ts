import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextResponse } from 'next/server'
import { google } from 'googleapis'

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID

type ActivityItem = {
  text: string
  brand: string
  date: string
  icon: string
}

function deriveActivity(row: string[]): { verb: string; icon: string } | null {
  const status = (row[14] ?? '').trim()
  switch (status) {
    case 'Sent':    return { verb: 'sent email to', icon: 'email' }
    case 'Replied': return { verb: 'received a reply from', icon: 'reply' }
    case 'Researched': return { verb: 'researched', icon: 'research' }
    case 'Qualified':  return { verb: 'qualified', icon: 'qualify' }
    case 'Called':     return { verb: 'called a contact at', icon: 'call' }
    case 'Passed':     return { verb: 'passed on', icon: 'pass' }
    case 'Skipped':    return { verb: 'skipped', icon: 'pass' }
    default: return status ? { verb: `marked ${status.toLowerCase()} for`, icon: 'update' } : null
  }
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT
    if (!serviceAccountRaw) {
      return NextResponse.json({ success: true, activity: [] })
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
    if (rows.length <= 1) return NextResponse.json({ success: true, activity: [] })

    const dataRows = rows.slice(1)
    const recent = dataRows.slice(-20).reverse()

    const activity: ActivityItem[] = recent
      .map(row => {
        const derived = deriveActivity(row)
        const brand = (row[0] ?? '').trim()
        if (!derived || !brand) return null
        const sentBy = (row[16] ?? '').trim() || 'A team member'
        return {
          text: `${sentBy} ${derived.verb} ${brand}`,
          brand,
          date: row[13] ?? '',
          icon: derived.icon
        }
      })
      .filter((x): x is ActivityItem => x !== null)
      .slice(0, 10)

    return NextResponse.json({ success: true, activity })
  } catch (error) {
    logSafeError('Activity fetch error:', error)
    return NextResponse.json({ success: true, activity: [] })
  }
}
