import React from 'react'
import type { TitleStatus, EpisodeStatus } from '../../types'

const TITLE_STATUS_LABELS: Record<TitleStatus, string> = {
  new: 'Новий',
  in_progress: 'В роботі',
  done: 'Готово',
}

const EPISODE_STATUS_LABELS: Record<EpisodeStatus, string> = {
  not_uploaded: 'Не завантажено',
  processing: 'Обробка',
  vocal_isolated: 'Вокал OK',
  marked: 'Марковано',
  ready: 'Готово',
}

const TITLE_STATUS_CLASS: Record<TitleStatus, string> = {
  new: 'status-new',
  in_progress: 'status-progress',
  done: 'status-done',
}

const EPISODE_STATUS_CLASS: Record<EpisodeStatus, string> = {
  not_uploaded: 'status-new',
  processing: 'status-progress',
  vocal_isolated: 'status-vocal',
  marked: 'status-marked',
  ready: 'status-done',
}

interface TitleBadgeProps {
  status: TitleStatus
}
export function TitleBadge({ status }: TitleBadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TITLE_STATUS_CLASS[status]}`}>
      {TITLE_STATUS_LABELS[status]}
    </span>
  )
}

interface EpisodeBadgeProps {
  status: EpisodeStatus
}
export function EpisodeBadge({ status }: EpisodeBadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${EPISODE_STATUS_CLASS[status]}`}>
      {EPISODE_STATUS_LABELS[status]}
    </span>
  )
}
