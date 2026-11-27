// Reusable centered auth layout used by login, device, and dashboard pages.

import type { ReactNode } from 'react'
import { Head, Link } from 'spiceflow/react'
import { cn } from '../lib/utils.ts'

export function BetterPlaywriterLogo({ className, imageClassName = 'h-7' }: { className?: string; imageClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center', className)}>
      <img
        src="/playwriter-logo.svg"
        alt="Better Playwriter"
        className={cn('w-auto', imageClassName)}
      />
    </span>
  )
}

export function AuthPage({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description: string
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Head>
        <Head.Title>{title ? `${title} | Better Playwriter` : 'Better Playwriter'}</Head.Title>
        <Head.Meta name="description" content={description} />
        <Head.Meta name="robots" content="noindex" />
      </Head>
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <Link href="/dashboard">
          <BetterPlaywriterLogo imageClassName="h-8" />
        </Link>
        <div className="flex flex-col gap-2">
          {title && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
          <p className="text-sm text-muted-foreground text-balance">{description}</p>
        </div>
        {children}
        {footer ? <div className="flex w-full flex-col gap-3">{footer}</div> : null}
      </div>
    </main>
  )
}
