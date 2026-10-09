import fs from 'node:fs'

const expected = JSON.parse(fs.readFileSync(new URL('../config/deployment.json', import.meta.url), 'utf8'))
const linked = JSON.parse(fs.readFileSync(new URL('../.vercel/project.json', import.meta.url), 'utf8'))
const mismatches = []
if (linked.orgId !== expected.orgId) mismatches.push(`orgId ${linked.orgId}`)
if (linked.projectId !== expected.projectId) mismatches.push(`projectId ${linked.projectId}`)
if (linked.projectName !== expected.projectName) mismatches.push(`projectName ${linked.projectName}`)
if (mismatches.length) {
  console.error(`Refusing deployment: linked target differs from config/deployment.json (${mismatches.join(', ')})`)
  process.exit(1)
}
console.log(`Deployment target valid: ${expected.teamName}/${expected.projectName}`)
