import fs from 'node:fs'

const schema = JSON.parse(fs.readFileSync(new URL('../config/env.schema.json', import.meta.url), 'utf8'))
if (process.argv.includes('--schema-only')) {
  if (!Array.isArray(schema.required) || !schema.rules || new Set(schema.required).size !== schema.required.length) throw new Error('Invalid environment manifest')
  console.log(`Environment manifest valid (${schema.required.length} required variables)`)
  process.exit(0)
}

const errors = []
for (const name of schema.required) if (!process.env[name]?.trim()) errors.push(`${name} is missing`)
const check = (name, rule) => {
  const value = process.env[name]?.trim()
  if (!value) return
  try {
    if (rule === 'email_list' && !value.split(',').every(item => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.trim()))) throw new Error()
    if (rule === 'min_32' && value.length < 32) throw new Error()
    if (rule === 'url' && !new URL(value).protocol) throw new Error()
    if (rule === 'https_url' && new URL(value).protocol !== 'https:') throw new Error()
    if (rule === 'service_account_json') {
      const parsed = JSON.parse(value)
      if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) throw new Error()
    }
  } catch { errors.push(`${name} failed ${rule} validation`) }
}
for (const [name, rule] of Object.entries(schema.rules)) check(name, rule)
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('Environment contract valid')
