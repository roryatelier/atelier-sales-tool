export type DraftProvenanceKind = 'manual-template' | 'automatic-template' | 'no-template' | 'fallback'

export interface DraftProvenance {
  kind: DraftProvenanceKind
  templateName: string | null
  roleGroup: string
}

interface GeneratedDraftProvenanceInput {
  apiTemplateName?: unknown
  selectedTemplateName?: string
  apiRoleGroup?: unknown
  requestedRole: string
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim()
  return cleaned || null
}

export function generatedDraftProvenance(input: GeneratedDraftProvenanceInput): DraftProvenance {
  const selectedTemplateName = cleanLabel(input.selectedTemplateName)
  const apiTemplateName = cleanLabel(input.apiTemplateName)
  const templateName = selectedTemplateName ?? apiTemplateName

  return {
    kind: selectedTemplateName
      ? 'manual-template'
      : templateName
        ? 'automatic-template'
        : 'no-template',
    templateName,
    roleGroup: cleanLabel(input.apiRoleGroup) ?? input.requestedRole,
  }
}

export function fallbackDraftProvenance(requestedRole: string): DraftProvenance {
  return {
    kind: 'fallback',
    templateName: null,
    roleGroup: requestedRole,
  }
}
