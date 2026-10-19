'use client'

import { userStorage } from '@/lib/browser-storage'
import { SIGNATURE_MAX_LENGTH } from '@/lib/email-signature'

import { useEffect, useState } from 'react'

interface Template {
  id: number
  name: string
  role: string
  subject: string
  body: string
  target_role: string
  created_at: string
}

const TEMPLATE_TYPES = [
  'Cold Outreach',
  'Follow-up',
  'Inbound Response',
  'Referral Intro',
  'Re-engagement',
  'Partnership Proposal'
]

const STAKEHOLDER_ROLES = [
  'General',
  'CEO',
  'CFO',
  'COO',
  'CMO',
  'Head of NPD',
  'Retailer'
]

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [filterType, setFilterType] = useState<string>('All')
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState('Cold Outreach')
  const [formTargetRole, setFormTargetRole] = useState('General')
  const [formSubject, setFormSubject] = useState('')
  const [formBody, setFormBody] = useState('')
  const [guidance, setGuidance] = useState('')
  const [savedGuidance, setSavedGuidance] = useState('')
  const [savingGuidance, setSavingGuidance] = useState(false)
  const [guidanceError, setGuidanceError] = useState('')
  const [signature, setSignature] = useState('')
  const [savedSignature, setSavedSignature] = useState('')
  const [signatureLoaded, setSignatureLoaded] = useState(false)
  const [savingSignature, setSavingSignature] = useState(false)
  const [signatureError, setSignatureError] = useState('')

  useEffect(() => {
    document.title = 'Templates — Atelier'
    void fetchTemplates().then(() => {
      void fetchGuidance()
      void fetchSignature()
    })
  }, [])

  async function fetchTemplates() {
    try {
      const res = await fetch('/api/templates')
      const data = await res.json()
      if (data.success) setTemplates(data.templates)
    } catch {
      console.error('Failed to fetch templates')
    } finally {
      setLoading(false)
    }
  }

  async function fetchGuidance() {
    try {
      const res = await fetch('/api/email-guidance')
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error('Guidance unavailable')
      setGuidance(data.guidance)
      setSavedGuidance(data.guidance)
    } catch {
      setGuidanceError('Email guidance could not be loaded. Refresh and try again.')
    }
  }

  async function fetchSignature() {
    try {
      const res = await fetch('/api/signature')
      const data = await res.json()
      if (!res.ok || !data.success || typeof data.signature !== 'string') throw new Error('Signature unavailable')
      setSignature(data.signature)
      setSavedSignature(data.signature)
      setSignatureLoaded(true)
    } catch {
      setSignatureError('Signature could not be loaded. Refresh and try again.')
    }
  }

  async function saveSignature() {
    if (!signatureLoaded || signature === savedSignature) return
    if (signature.length > SIGNATURE_MAX_LENGTH) {
      setSignatureError('Signature is too long.')
      return
    }
    setSavingSignature(true)
    setSignatureError('')
    try {
      const res = await fetch('/api/signature', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature })
      })
      const data = await res.json()
      if (!res.ok || !data.success || typeof data.signature !== 'string') throw new Error('Signature update failed')
      setSignature(data.signature)
      setSavedSignature(data.signature)
    } catch {
      setSignatureError('Signature could not be saved. Your changes remain in this editor.')
    } finally {
      setSavingSignature(false)
    }
  }

  async function saveGuidance() {
    if (!guidance.trim() || guidance === savedGuidance) return
    setSavingGuidance(true)
    setGuidanceError('')
    try {
      const res = await fetch('/api/email-guidance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidance })
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error('Guidance update failed')
      setSavedGuidance(guidance.trim())
      setGuidance(guidance.trim())
    } catch {
      setGuidanceError('Email guidance could not be saved. Your changes remain in this editor.')
    } finally {
      setSavingGuidance(false)
    }
  }

  function openCreate() {
    setEditingId(null)
    setFormName('')
    setFormType('Cold Outreach')
    setFormTargetRole('General')
    setFormSubject('')
    setFormBody('')
    setShowForm(true)
  }

  function openEdit(t: Template) {
    setEditingId(t.id)
    setFormName(t.name)
    setFormType(t.role)
    setFormTargetRole(t.target_role || 'General')
    setFormSubject(t.subject)
    setFormBody(t.body)
    setShowForm(true)
    setSelectedTemplate(null)
  }

  function cancelForm() {
    setShowForm(false)
    setEditingId(null)
  }

  async function handleSave() {
    if (!formName || !formSubject || !formBody) return
    setSaving(true)
    try {
      const payload = {
        name: formName,
        role: formType,
        subject: formSubject,
        body: formBody,
        target_role: formTargetRole === 'General' ? '' : formTargetRole
      }
      const res = await fetch('/api/templates', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { id: editingId, ...payload } : payload)
      })
      const data = await res.json()
      if (data.success) {
        setShowForm(false)
        setEditingId(null)
        fetchTemplates()
      }
    } catch {
      console.error('Failed to save template')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!window.confirm(`Delete template "${name}"? This cannot be undone.`)) return
    try {
      await fetch(`/api/templates?id=${id}`, { method: 'DELETE' })
      setTemplates(templates.filter(t => t.id !== id))
      if (selectedTemplate?.id === id) setSelectedTemplate(null)
    } catch {
      console.error('Failed to delete template')
    }
  }

  const filteredTemplates = filterType === 'All'
    ? templates
    : templates.filter(t => t.role === filterType)

  return (
    <div style={{ zoom: 0.8 }}>
      <div className="page-eyebrow">Templates</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 className="page-title">Email Templates</h1>
        <button onClick={openCreate} className="btn btn-primary">
          + New template
        </button>
      </div>
      <p className="page-sub" style={{ marginBottom: 24 }}>Edit the guidance, your signature, and role-based templates used by the email generator.</p>

      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginBottom: 12 }}>
          <div>
            <div className="section-label" style={{ marginBottom: 6 }}>Email guidance</div>
            <div style={{ color: 'var(--slate-400)', fontSize: 13 }}>Applied to every generated email. Role templates below supply the structure and examples.</div>
          </div>
          <button
            onClick={saveGuidance}
            disabled={savingGuidance || !guidance.trim() || guidance === savedGuidance}
            className="btn btn-primary btn-sm"
          >
            {savingGuidance ? 'Saving...' : guidance === savedGuidance ? 'Saved' : 'Save guidance'}
          </button>
        </div>
        <textarea
          value={guidance}
          onChange={event => setGuidance(event.target.value)}
          rows={8}
          className="textarea"
          aria-label="Email generator guidance"
        />
        {guidanceError && <div style={{ color: 'var(--red-400)', fontSize: 12, marginTop: 8 }}>{guidanceError}</div>}
      </div>

      <div id="signature" className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginBottom: 12 }}>
          <div>
            <div className="section-label" style={{ marginBottom: 6 }}>Signature</div>
            <div style={{ color: 'var(--slate-400)', fontSize: 13 }}>Saved for the signed-in Google account and appended after each draft. Line breaks and links such as [site](https://example.invalid) are kept.</div>
          </div>
          <button
            onClick={saveSignature}
            disabled={!signatureLoaded || savingSignature || signature === savedSignature || signature.length > SIGNATURE_MAX_LENGTH}
            className="btn btn-primary btn-sm"
          >
            {savingSignature ? 'Saving...' : signature === savedSignature ? 'Saved' : 'Save signature'}
          </button>
        </div>
        <textarea
          value={signature}
          onChange={event => setSignature(event.target.value)}
          rows={6}
          className="textarea"
          aria-label="Email signature"
          placeholder={'Thanks,\nYour name\n[site](https://example.invalid)'}
        />
        {signatureError && <div style={{ color: 'var(--red-400)', fontSize: 12, marginTop: 8 }}>{signatureError}</div>}
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="section-label" style={{ marginBottom: 16 }}>{editingId ? 'Edit template' : 'Create new template'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label className="field-label">Template name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. Prestige skincare cold outreach"
                  className="input"
                />
              </div>
              <div>
                <label className="field-label">Template type</label>
                <div className="role-row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                  {TEMPLATE_TYPES.map(type => (
                    <button
                      key={type}
                      onClick={() => setFormType(type)}
                      className={`role-btn ${formType === type ? 'active' : ''}`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <label className="field-label">Stakeholder role <span style={{ fontWeight: 400, color: 'var(--slate-400)' }}>(optional — auto-switches role in email generator)</span></label>
              <div className="role-row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                {STAKEHOLDER_ROLES.map(r => (
                  <button
                    key={r}
                    onClick={() => setFormTargetRole(r)}
                    className={`role-btn ${formTargetRole === r ? 'active' : ''}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="field-label">Subject line</label>
              <input
                type="text"
                value={formSubject}
                onChange={e => setFormSubject(e.target.value)}
                placeholder="e.g. Manufacturing partnership — [Brand name]"
                className="input"
              />
            </div>
            <div>
              <label className="field-label">Email body</label>
              <textarea
                value={formBody}
                onChange={e => setFormBody(e.target.value)}
                placeholder="Paste your existing email here or write a new one. Use [Brand name], [Contact name], [Retailer] as placeholders."
                rows={12}
                className="textarea"
              />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={handleSave}
                disabled={saving || !formName || !formSubject || !formBody}
                className="btn btn-primary"
              >
                {saving ? 'Saving...' : editingId ? 'Update template' : 'Save template'}
              </button>
              <button onClick={cancelForm} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div className="role-row" style={{ flexWrap: 'wrap' }}>
          {['All', ...TEMPLATE_TYPES].map(type => (
            <button
              key={type}
              onClick={() => setFilterType(type)}
              className={`role-btn ${filterType === type ? 'active' : ''}`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--slate-400)', fontSize: 14 }}>
          <div className="spinner" />
          Loading templates...
        </div>
      )}

      {!loading && filteredTemplates.length === 0 && (
        <div className="table-wrap">
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--slate-400)', fontSize: 13 }}>
            No templates yet. Click <strong>+ New template</strong> to get started.
          </div>
        </div>
      )}

      {!loading && filteredTemplates.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: selectedTemplate ? '1fr 1fr' : '1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filteredTemplates.map(template => (
              <div
                key={template.id}
                className="card-hair"
                style={{
                  padding: '16px 20px',
                  cursor: 'pointer',
                  borderColor: selectedTemplate?.id === template.id ? 'var(--black)' : undefined,
                  background: selectedTemplate?.id === template.id ? 'var(--slate-100)' : '#fff'
                }}
                onClick={() => setSelectedTemplate(template)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', background: 'var(--brand-100)', color: 'var(--brand-400)', padding: '2px 8px', borderRadius: 4 }}>
                      {template.role}
                    </span>
                    {template.target_role && (
                      <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', background: 'var(--slate-100)', color: 'var(--slate-500)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--black-100)' }}>
                        {template.target_role}
                      </span>
                    )}
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{template.name}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      onClick={e => { e.stopPropagation(); openEdit(template) }}
                      style={{ background: 'none', border: '1px solid var(--black-100)', cursor: 'pointer', color: 'var(--slate-500)', fontSize: 12, padding: '3px 10px', borderRadius: 4 }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(template.id, template.name) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--slate-400)', fontSize: 18, padding: '2px 6px' }}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 4 }}>{template.subject}</div>
                <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>
                  {new Date(template.created_at).toLocaleDateString('en-AU')}
                </div>
              </div>
            ))}
          </div>

          {selectedTemplate && (
            <div className="card" style={{ alignSelf: 'start' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--slate-400)' }}>{selectedTemplate.role}</span>
                    {selectedTemplate.target_role && (
                      <span style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', background: 'var(--slate-100)', color: 'var(--slate-500)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--black-100)' }}>
                        {selectedTemplate.target_role}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 500 }}>{selectedTemplate.name}</div>
                </div>
                <button
                  onClick={() => {
                    userStorage.setItem('email_template', JSON.stringify(selectedTemplate))
                    window.location.href = '/email'
                  }}
                  className="btn btn-primary btn-sm"
                >
                  Use in email generator
                </button>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div className="field-label">Subject</div>
                <div style={{ fontSize: 13, color: 'var(--text-default)', background: 'var(--slate-100)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--black-100)' }}>
                  {selectedTemplate.subject}
                </div>
              </div>
              <div>
                <div className="field-label">Body</div>
                <div style={{ fontSize: 13, color: 'var(--text-default)', background: 'var(--slate-100)', padding: '14px 16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--black-100)', whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 400, overflowY: 'auto' }}>
                  {selectedTemplate.body}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
