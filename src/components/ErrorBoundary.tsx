import React from 'react'
import { reportError } from '../utils/reportError'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

// A single uncaught error anywhere in the render tree (e.g. the JASSUB/WASM
// CompileError seen live once already) otherwise unmounts the whole app to a
// blank window with zero indication of what happened. This is the last line
// of defense so that instead shows a recoverable message.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Uncaught render error', error, info.componentStack)
    reportError(error.message, error.stack ?? info.componentStack, 'render')
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-screen h-screen flex items-center justify-center bg-[#0A0A0C] text-white">
          <div className="max-w-md text-center space-y-3">
            <div className="text-lg font-semibold">Сталася помилка інтерфейсу</div>
            <div className="text-sm text-rh-muted whitespace-pre-wrap break-words">
              {this.state.error.message}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-1.5 rounded-md bg-rh-accent text-white text-sm font-semibold hover:opacity-90"
            >
              Перезавантажити
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
