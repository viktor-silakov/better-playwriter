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
        {`# Sign in to this service, then open a cloud browser
export BETTER_PLAYWRITER_CLOUD_URL=${quotedCloudUrl}
better-playwriter cloud login
better-playwriter session new --browser cloud
better-playwriter -s 1 -e "state.page = await context.newPage(); await state.page.goto('https://example.com')"
better-playwriter -s 1 -e "console.log(await snapshot({ page: state.page }))"

# Or just set your API key and run directly
export BETTER_PLAYWRITER_API_KEY="your-api-key"
better-playwriter session new --browser cloud`}
      </CodeBlock>
    </div>
  )
}

function McpContent({ cloudUrl }: { cloudUrl: string }) {
  return (
    <div className="flex flex-col gap-5">
      <CodeBlock lang="json" showLineNumbers={false} bleed="none">
        {`{
  "mcpServers": {
    "better-playwriter": {
      "command": "npx",
      "args": ["-y", "better-playwriter@latest"],
      "env": {
        "BETTER_PLAYWRITER_CLOUD_URL": ${JSON.stringify(cloudUrl)},
        "BETTER_PLAYWRITER_API_KEY": "your-api-key"
      }
    }
  }
}`}
      </CodeBlock>
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

      {tab === 'cli' ? <CliContent cloudUrl={cloudUrl} /> : <McpContent cloudUrl={cloudUrl} />}
    </div>
  )
}
