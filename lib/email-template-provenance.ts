export type DraftProvenanceKind = 'manual-template' | 'automatic-template' | 'no-template' | 'fallback'
export type GuidanceProvenanceSource = 'stored' | 'default'

export interface DraftProvenance {
  kind: DraftProvenanceKind
  templateName: string | null
  roleGroup: string
  // Optional guidance provenance. Absent for drafts generated before this field
  // existed (or when the API did not report guidance provenance), so the UI must
  // render defensively rather than assume it is present.
  guidanceSource?: GuidanceProvenanceSource
  guidanceRevision?: string
}

interface GeneratedDraftProvenanceInput {
  apiTemplateName?: unknown
  selectedTemplateName?: string
  apiRoleGroup?: unknown
  requestedRole: string
  apiGuidanceSource?: unknown
  apiGuidanceRevision?: unknown
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim()
  return cleaned || null
}

function cleanGuidanceSource(value: unknown): GuidanceProvenanceSource | null {
  return value === 'stored' || value === 'default' ? value : null
}

export function generatedDraftProvenance(input: GeneratedDraftProvenanceInput): DraftProvenance {
  const selectedTemplateName = cleanLabel(input.selectedTemplateName)
  const apiTemplateName = cleanLabel(input.apiTemplateName)
  const templateName = selectedTemplateName ?? apiTemplateName
  const guidanceSource = cleanGuidanceSource(input.apiGuidanceSource)
  const guidanceRevision = cleanLabel(input.apiGuidanceRevision)
  return {
    kind: selectedTemplateName
      ? 'manual-template'
      : templateName
        ? 'automatic-template'
        : 'no-template',
    templateName,
    roleGroup: cleanLabel(input.apiRoleGroup) ?? input.requestedRole,
    // Only attach guidance provenance when the API actually reported it; the fields
    // are omitted (not undefined-valued) so serialised snapshots stay shape-stable.
    ...(guidanceSource
      ? { guidanceSource, guidanceRevision: guidanceSource === 'default' ? 'default' : guidanceRevision ?? 'unknown' }
      : {}),
  }
}

export function fallbackDraftProvenance(requestedRole: string): DraftProvenance {
  return {
    kind: 'fallback',
    templateName: null,
    roleGroup: requestedRole,
  }
}
