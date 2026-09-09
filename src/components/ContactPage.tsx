import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { FeedbackPanel } from './FeedbackPanel'
import type { AppSettings } from '../types'

// Moved out of Settings into its own page — this is where suggestions/bug
// reports to the developer live now, separate from the app's own
// configuration. Fetches just the two fields it needs rather than the full
// settings object SettingsPage manages, since this page has no business
// touching anything else there.
export function ContactPage() {
  const { get, put } = useApi()
  const [showInbox, setShowInbox] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    get<AppSettings>('/settings').then((s) => {
      setShowInbox(s.show_feedback_inbox)
      setIsAdmin(!!s.active_profile?.is_admin)
      setLoaded(true)
    }).catch(() => {})
  }, [get])

  async function toggleInbox(v: boolean) {
    setShowInbox(v)
    try {
      await put('/settings', { show_feedback_inbox: v })
    } catch {
      /* keep optimistic local state if backend unreachable */
    }
  }

  return (
    <main className="relative z-[1] p-5 px-6 max-w-[760px] mx-auto overflow-y-auto h-full">
      <h1 className="m-0 mb-3.5 text-lg font-black">Зв'язок з розробником</h1>
      {loaded && <FeedbackPanel showInbox={showInbox} onToggleInbox={toggleInbox} isAdmin={isAdmin} />}
    </main>
  )
}
