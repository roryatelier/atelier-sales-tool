import { logSafeError } from '@/lib/safe-log'
import { authorizeRequest } from '@/lib/api-auth'
import { NextRequest, NextResponse } from 'next/server'
import { researchBrand } from '@/lib/research'
import { initialiseDb } from '@/lib/db'

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request)
  if (auth.error) return auth.error

  try {
    await initialiseDb()
    const body = await request.json()
    const { brand_name } = body

    if (!brand_name || typeof brand_name !== 'string' || brand_name.trim() === '') {
      return NextResponse.json({ error: 'brand_name is required' }, { status: 400 })
    }

    const dossier = await researchBrand(brand_name.trim())
    return NextResponse.json({ success: true, dossier })

  } catch (error) {
    logSafeError('Research route error:', error)
    return NextResponse.json({ error: 'Research failed. Check server logs.' }, { status: 500 })
  }
}