import { create } from 'zustand'
import type { Title, Episode, JobStatus, WsMessage, Profile, PowerShareRequestPayload, PowerShareLendingPayload, PowerShareModelDownloadPayload, PowerShareBorrowingPayload } from '../types'

interface AppState {
  backendPort: number
  backendReady: boolean
  titles: Title[]
  selectedTitleId: number | null
  selectedEpisodeId: number | null
  showSettings: boolean
  showModelBrowser: boolean
  showTeams: boolean
  showContact: boolean
  activeJobs: Map<string, JobStatus>
  activeProfile: Profile | null
  incomingPowerShareRequest: PowerShareRequestPayload | null
  incomingModelDownloadRequest: PowerShareModelDownloadPayload | null
  lendingStatus: PowerShareLendingPayload | null
  borrowingStatus: PowerShareBorrowingPayload | null
  forceUpdateNotice: { from_name: string } | null
  teamInviteNotice: { invite_id: string; team_id: string; team_name: string } | null
  // Bumped to Date.now() whenever the backend pulls a fresh shared-titles
  // snapshot (see backend discovery_service.py's "shared_content_updated"
  // relay/heartbeat handling) — components showing titles/episodes watch
  // this in a useEffect to silently refetch, no window-switching needed.
  sharedContentUpdatedAt: number

  setBackendPort: (port: number) => void
  setBackendReady: (ready: boolean) => void
  setTitles: (titles: Title[]) => void
  setSelectedTitle: (id: number | null) => void
  setSelectedEpisode: (id: number | null) => void
  setShowSettings: (show: boolean) => void
  setShowModelBrowser: (show: boolean) => void
  setShowTeams: (show: boolean) => void
  setShowContact: (show: boolean) => void
  setActiveProfile: (profile: Profile | null) => void
  clearIncomingPowerShareRequest: () => void
  clearIncomingModelDownloadRequest: () => void
  clearForceUpdateNotice: () => void
  clearTeamInviteNotice: () => void
  upsertJob: (job: JobStatus) => void
  removeJob: (jobId: string) => void
  reconcileActiveJobs: (liveJobIds: string[]) => void
  handleWsMessage: (msg: WsMessage) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  backendPort: 8765,
  backendReady: false,
  titles: [],
  selectedTitleId: null,
  selectedEpisodeId: null,
  showSettings: false,
  showModelBrowser: false,
  showTeams: false,
  showContact: false,
  activeJobs: new Map(),
  activeProfile: null,
  incomingPowerShareRequest: null,
  incomingModelDownloadRequest: null,
  lendingStatus: null,
  borrowingStatus: null,
  forceUpdateNotice: null,
  teamInviteNotice: null,
  sharedContentUpdatedAt: 0,

  setBackendPort: (port) => set({ backendPort: port }),
  setBackendReady: (ready) => set({ backendReady: ready }),
  setTitles: (titles) => set({ titles }),
  setSelectedTitle: (id) => set({ selectedTitleId: id, selectedEpisodeId: null, showSettings: false, showModelBrowser: false, showTeams: false, showContact: false }),
  setSelectedEpisode: (id) => set({ selectedEpisodeId: id }),
  setShowSettings: (show) => set((state) => ({
    showSettings: show,
    showModelBrowser: show ? false : state.showModelBrowser,
    showTeams: show ? false : state.showTeams,
    showContact: show ? false : state.showContact,
  })),
  setShowModelBrowser: (show) => set((state) => ({
    showModelBrowser: show,
    showSettings: show ? false : state.showSettings,
    showTeams: show ? false : state.showTeams,
    showContact: show ? false : state.showContact,
    selectedTitleId: show ? null : state.selectedTitleId,
    selectedEpisodeId: show ? null : state.selectedEpisodeId,
  })),
  setShowTeams: (show) => set((state) => ({
    showTeams: show,
    showSettings: show ? false : state.showSettings,
    showModelBrowser: show ? false : state.showModelBrowser,
    showContact: show ? false : state.showContact,
    selectedTitleId: show ? null : state.selectedTitleId,
    selectedEpisodeId: show ? null : state.selectedEpisodeId,
  })),
  setShowContact: (show) => set((state) => ({
    showContact: show,
    showSettings: show ? false : state.showSettings,
    showModelBrowser: show ? false : state.showModelBrowser,
    showTeams: show ? false : state.showTeams,
    selectedTitleId: show ? null : state.selectedTitleId,
    selectedEpisodeId: show ? null : state.selectedEpisodeId,
  })),
  setActiveProfile: (profile) => set({ activeProfile: profile }),
  clearIncomingPowerShareRequest: () => set({ incomingPowerShareRequest: null }),
  clearIncomingModelDownloadRequest: () => set({ incomingModelDownloadRequest: null }),
  clearForceUpdateNotice: () => set({ forceUpdateNotice: null }),
  clearTeamInviteNotice: () => set({ teamInviteNotice: null }),

  upsertJob: (job) => set((state) => {
    const jobs = new Map(state.activeJobs)
    jobs.set(job.id, job)
    return { activeJobs: jobs }
  }),

  removeJob: (jobId) => set((state) => {
    const jobs = new Map(state.activeJobs)
    jobs.delete(jobId)
    return { activeJobs: jobs }
  }),

  // job_manager's job registry lives only in the backend's process memory —
  // it's wiped on every backend restart. If the frontend still thinks a job
  // is "running" from before a restart (or a missed/dropped WS message), the
  // backend will never send another update for that id, and the tile's
  // percent/message freezes forever. Called once per WS (re)connect with the
  // backend's current job list, so anything the backend no longer knows
  // about gets dropped instead of showing a stale progress bar indefinitely.
  reconcileActiveJobs: (liveJobIds) => set((state) => {
    const live = new Set(liveJobIds)
    let changed = false
    const jobs = new Map(state.activeJobs)
    for (const [id, job] of jobs) {
      if (job.status === 'running' && !live.has(id)) {
        jobs.delete(id)
        changed = true
      }
    }
    return changed ? { activeJobs: jobs } : state
  }),

  handleWsMessage: (msg) => {
    const { upsertJob, removeJob } = get()
    if (msg.type === 'power_share_request') {
      set({ incomingPowerShareRequest: msg.data as unknown as PowerShareRequestPayload })
      return
    }
    if (msg.type === 'power_share_model_download_request') {
      set({ incomingModelDownloadRequest: msg.data as unknown as PowerShareModelDownloadPayload })
      return
    }
    if (msg.type === 'power_share_lending') {
      const data = msg.data as unknown as PowerShareLendingPayload
      set({ lendingStatus: data.active ? data : null })
      return
    }
    if (msg.type === 'power_share_borrowing') {
      const data = msg.data as unknown as PowerShareBorrowingPayload
      set({ borrowingStatus: data.active ? data : null })
      return
    }
    if (msg.type === 'force_update_request') {
      set({ forceUpdateNotice: msg.data as unknown as { from_name: string } })
      return
    }
    if (msg.type === 'team_invite') {
      set({ teamInviteNotice: msg.data as unknown as { invite_id: string; team_id: string; team_name: string } })
      return
    }
    if (msg.type === 'shared_content_updated') {
      set({ sharedContentUpdatedAt: Date.now() })
      return
    }
    if (!msg.job_id) return
    if (msg.type === 'progress' || msg.type === 'status') {
      // update job
      const existing = get().activeJobs.get(msg.job_id)
      if (existing) {
        upsertJob({
          ...existing,
          percent: msg.percent ?? existing.percent,
          message: msg.message ?? existing.message,
          status: 'running',
        })
      }
    } else if (msg.type === 'complete') {
      const existing = get().activeJobs.get(msg.job_id)
      if (existing) {
        // msg.data carries the job's return value (e.g. batch separation's
        // {output_dir, models}) — without forwarding it onto the job here,
        // any UI that reads job.result after completion (the batch-output
        // folder auto-open, the results picker) silently no-ops because
        // result stays whatever it was at job creation (nothing).
        upsertJob({ ...existing, status: 'complete', percent: 100, message: 'Готово', result: msg.data ?? existing.result })
        setTimeout(() => removeJob(msg.job_id!), 3000)
      }
    } else if (msg.type === 'error') {
      const existing = get().activeJobs.get(msg.job_id)
      if (existing) {
        upsertJob({ ...existing, status: 'error', message: msg.error ?? 'Помилка' })
      }
    } else if (msg.type === 'cancelled') {
      const existing = get().activeJobs.get(msg.job_id)
      if (existing) {
        upsertJob({ ...existing, status: 'cancelled', message: 'Скасовано' })
        setTimeout(() => removeJob(msg.job_id!), 3000)
      }
    }
  },
}))
