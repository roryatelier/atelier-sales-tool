import fs from 'node:fs'
import path from 'node:path'

const roots = ['app', 'lib', 'tests', 'package.json', 'package-lock.json', 'README.md', 'doc/HANDOVER.md', 'doc/TECHNICAL_HANDOOFF.md', 'Prompts']
const forbidden = [/anthropic/i, /claude-(?:sonnet|opus|haiku)/i, /atelier-three-chi/i]
const findings = []
function scan(target) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) return fs.readdirSync(target).forEach(name => scan(path.join(target, name)))
  const text = fs.readFileSync(target, 'utf8')
  text.split('\n').forEach((line, index) => { if (forbidden.some(pattern => pattern.test(line))) findings.push(`${target}:${index + 1}`) })
}
roots.forEach(scan)
if (findings.length) {
  console.error(`Retired provider or deployment references found:\n${findings.join('\n')}`)
  process.exit(1)
}
console.log('Provider policy valid')
