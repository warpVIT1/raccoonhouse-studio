import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { reportError } from './utils/reportError'
import './index.css'

// Catches errors ErrorBoundary structurally can't — event handlers, timers,
// async code outside React's render tree (a thrown Error there never
// reaches componentDidCatch). Same destination (see reportError.ts).
window.addEventListener('error', (e) => {
  reportError(e.message, e.error?.stack, 'window')
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  reportError(message, stack, 'unhandledrejection')
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
