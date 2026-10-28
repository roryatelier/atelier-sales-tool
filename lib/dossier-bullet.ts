// Dossier signal bullets come from research output. Rendering keeps the **bold**
// convention but only after every character is HTML-escaped, so injected markup
// like <script> or onerror attributes can never execute.
const ENTITY_MAP: Record<string, string> = {
  '&': '\u0026amp;',
  '<': '\u0026lt;',
  '>': '\u0026gt;',
  '"': '\u0026quot;',
  "'": '\u0026#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ENTITY_MAP[ch])
}

export function renderDossierBullet(bullet: string): string {
  const text = escapeHtml(bullet.trim().replace(/\.$/, ''))
  return text.replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:600;color:var(--text-default)">$1</strong>')
}
