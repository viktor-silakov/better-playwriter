// Dashboard panel showing code snippets for getting started with cloud browsers.
// Uses holocron's CodeBlock for Prism syntax highlighting with copy button.
'use client'

import { useState } from 'react'
import { CodeBlock } from '@holocron.so/vite/mdx'

type Tab = 'cli' | 'mcp'

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function CliContent({ cloudUrl }: { cloudUrl: string }) {
  const quotedCloudUrl = `'${cloudUrl.replaceAll("'", "'\\''")}'`

  return (
    <div className="flex flex-col gap-5">
      <CodeBlock lang="bash" showLineNumbers={false} bleed="none">
        {`# Set the API key issued by this dashboard in CLOUD_API_KEY.
response=$(curl --fail-with-body -sS -X POST ${quotedCloudUrl}/api/cloud/connect \\
  -H "x-api-key: $CLOUD_API_KEY" -H "Content-Type: application/json" -d '{}') &&
CDP_URL=$(printf '%s' "$response" | jq -er '.cdpUrl | strings | select(length > 0)') &&
better-playwriter session new --direct "$CDP_URL"

# When finished, stop the browser with the provider.
curl --fail-with-body -sS -X POST ${quotedCloudUrl}/api/cloud/disconnect \\
  -H "x-api-key: $CLOUD_API_KEY" -H "Content-Type: application/json" \\
  -d "$(printf '%s' "$response" | jq -c '{cloudSessionId}')"`}
      </CodeBlock>
    </div>
  )
}

function McpContent() {
  return (
    <div className="flex flex-col gap-5">
      <CodeBlock lang="json" showLineNumbers={false} bleed="none">
        {`{
  "mcpServers": {
    "better-playwriter": {
      "command": "npx",
      "args": ["-y", "better-playwriter@latest"]
    }
  }
}`}
      </CodeBlock>
      <p className="text-sm text-muted-foreground">
        Create the browser with the provider, then call <code>session_new</code> with its CDP URL in <code>direct</code>.
      </p>
    </div>
  )
}

export function QuickStartPanel({ cloudUrl }: { cloudUrl: string }) {
  const [tab, setTab] = useState<Tab>('cli')

  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-border bg-background p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">Quick Start</h2>
        <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
          <TabButton active={tab === 'cli'} onClick={() => { setTab('cli') }}>CLI</TabButton>
          <TabButton active={tab === 'mcp'} onClick={() => { setTab('mcp') }}>MCP</TabButton>
        </div>
      </div>

      {tab === 'cli' ? <CliContent cloudUrl={cloudUrl} /> : <McpContent />}
    </div>
  )
}
