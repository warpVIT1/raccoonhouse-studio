import React from 'react'

// Deliberately not a full Markdown engine (no new dependency for something
// this narrow) — just the subset actually used in GitHub release notes:
// "## " headings, "- " bullet lists, "**bold**" inline, blank-line
// paragraph breaks. Anything else renders as plain text rather than
// crashing on it.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>
  })
}

export function MiniMarkdown({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let listItems: string[] = []

  function flushList(key: string) {
    if (!listItems.length) return
    blocks.push(
      <ul key={`ul-${key}`} className="list-disc pl-4 flex flex-col gap-0.5">
        {listItems.map((item, i) => <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>)}
      </ul>
    )
    listItems = []
  }

  lines.forEach((line, i) => {
    const heading = line.match(/^#{1,6}\s+(.*)/)
    const bullet = line.match(/^[-*]\s+(.*)/)
    if (heading) {
      flushList(String(i))
      blocks.push(<div key={i} className="font-semibold text-rh-text mt-1.5 first:mt-0">{renderInline(heading[1], `h-${i}`)}</div>)
    } else if (bullet) {
      listItems.push(bullet[1])
    } else if (line.trim() === '') {
      flushList(String(i))
    } else {
      flushList(String(i))
      blocks.push(<div key={i}>{renderInline(line, `p-${i}`)}</div>)
    }
  })
  flushList('end')

  return <div className={className}>{blocks}</div>
}
