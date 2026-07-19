import { create } from 'zustand'
import type { Title, Episode, JobStatus, WsMessage, Profile, PowerShareRequestPayload, PowerShareLendingPayload } from '../types'

interface AppState {
  backendPort: number
  backendReady: boolean
  titles: Title[]
  selectedTitleId: number | null
  selectedEpisodeId: number | null
  showSettings: boolean
  activeJobs: Map<string, JobStatus>
  activeProfile: Profile | null
  incomingPowerShareRequest: PowerShareRequestPayload | null
  lendingStatus: PowerShareLendingPayload | null

  setBackendPort: (port: number) => void
  setBackendReady: (ready: boolean) => void
  setTitles: (titles: Title[]) => void
  setSelectedTitle: (id: number | null) => void
  setSelectedEpisode: (id: number | null) => void
  setShowSettings: (show: boolean) => void
  setActiveProfile: (profile: Profile | null) => void
  clearIncomingPowerShareRequest: () => void
  upsertJob: (job: JobStatus) => void
  removeJob: (jobId: string) => void
  handleWsMessage: (msg: WsMessage) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  backendPort: 8765,
  backendReady: false,
  titles: [],
  selectedTitleId: null,
  selectedEpisodeId: null,
  showSettings: false,
  activeJobs: new Map(),
  activeProfile: null,
  incomingPowerShareRequest: null,
  lendingStatus: null,

  setBackendPort: (port) => set({ backendPort: port }),
  setBackendReady: (ready) => set({ backendReady: ready }),
  setTitles: (titles) => set({ titles }),
  setSelectedTitle: (id) => set({ selectedTitleId: id, selectedEpisodeId: null, showSettings: false }),
  setSelectedEpisode: (id) => set({ selectedEpisodeId: id }),
  setShowSettings: (show) => set({ showSettings: show }),
  setActiveProfile: (profile) => set({ activeProfile: profile }),
  clearIncomingPowerShareRequest: () => set({ incomingPowerShareRequest: null }),

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

  handleWsMessage: (msg) => {
    const { upsertJob, removeJob } = get()
    if (msg.type === 'power_share_request') {
      set({ incomingPowerShareRequest: msg.data as unknown as PowerShareRequestPayload })
      return
    }
    if (msg.type === 'power_share_lending') {
      const data = msg.data as unknown as PowerShareLendingPayload
      set({ lendingStatus: data.active ? data : null })
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
        upsertJob({ ...existing, status: 'complete', percent: 100, message: 'Готово' })
        setTimeout(() => removeJob(msg.job_id!), 3000)
      }
    } else if (msg.type === 'error') {
      const existing = get().activeJobs.get(msg.job_id)
      if (existing) {
        upsertJob({ ...existing, status: 'error', message: msg.error ?? 'Помилка' })
      }
    }
  },
}))
