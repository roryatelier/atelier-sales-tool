'use client'
import { useState } from 'react'
import { validContactEmail, type LushaContact, type RevealedEmail } from '@/lib/lusha-contact'
export default function ContactEmailActions({contact,busy,error,choices,onReveal,onChoose}: { contact:LushaContact;busy:boolean;error?:string;choices?:RevealedEmail[];onReveal:()=>void;onChoose:(email:string)=>boolean }) {
  const [manual,setManual] = useState('')
  return <div onClick={e => e.stopPropagation()} style={{marginTop:8}}>
    {contact.email ? <div>{contact.email}</div> : <>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !!choices?.length} onClick={onReveal}>{busy ? 'Revealing…' : 'Reveal email'}</button>
      {error && <p role="alert" style={{fontSize:12}}>{error}</p>}
      {choices?.map(choice => <button type="button" className="btn btn-secondary btn-sm" key={choice.email} onClick={() => onChoose(choice.email)}>Use {choice.type} email: {choice.email}</button>)}
      <div style={{display:'flex',gap:4,marginTop:6}}><input aria-label={`Manual email for ${contact.name}`} type="email" value={manual} onChange={e => setManual(e.target.value)} placeholder="Known email address" style={{minWidth:0,width:160}}/><button type="button" className="btn btn-secondary btn-sm" disabled={busy || !validContactEmail(manual.trim())} onClick={() => onChoose(manual.trim())}>Use email</button></div>
    </>}
  </div>
}
