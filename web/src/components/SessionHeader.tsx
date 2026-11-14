import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, Download, ExternalLink, GitBranch, GitPullRequest, Menu } from 'lucide-react';
import { api, type View } from '../api.ts';
import { navigate } from '../router.ts';
import { fullDate, projectName, sourceLabel, tokens, usd } from '../format.ts';

export function SessionHeader({ sessionId, view, onMenu }: { sessionId: string; view: View; onMenu: () => void }) {
  const q = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
  const s = q.data;
  const facts = s
    ? [
        sourceLabel(s.sourceId),
        projectName(s.projectPath, s.projectKey),
        fullDate(s.startedAt),
        `${s.messageCount} messages`,
        s.costUSD ? usd(s.costUSD) : undefined,
        s.inputTokens || s.outputTokens ? `${tokens(s.inputTokens)} in / ${tokens(s.outputTokens)} out` : undefined,
        s.models.length ? s.models.join(', ') : undefined,
      ].filter(Boolean)
    : [];

  return (
    <header className="border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <button type="button" onClick={onMenu} aria-label="Show chats" className="mt-0.5 rounded p-1 text-muted hover:bg-sunken lg:hidden">
          <Menu size={18} />
        </button>
        <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-0">
          {s?.parentSessionId && (
            <button type="button" onClick={() => navigate({ sessionId: s.parentSessionId, seq: undefined })} className="mb-1 inline-flex items-center gap-1 text-[12.5px] text-prompt hover:underline">
              <ArrowLeft size={13} /> Back to the main chat
            </button>
          )}
          <h1 className="truncate text-[17px] leading-snug font-semibold" title={s?.title}>
            {s?.parentSessionId && <Bot size={16} className="mr-1.5 inline -translate-y-px text-muted" />}
            {s ? s.agentDescription || s.title || s.firstPrompt || 'Untitled chat' : ' '}
          </h1>
          <p className="mt-0.5 truncate text-[12.5px] text-muted" title={s?.filePath}>
            {facts.join('  ·  ')}
          </p>
          {s && ((s.gitBranch && s.gitBranch !== 'HEAD') || s.links.length > 0 || s.subSessions.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
              {s.gitBranch && s.gitBranch !== 'HEAD' && (
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={12} /> {s.gitBranch}
                </span>
              )}
              {s.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-prompt hover:underline">
                  {l.kind === 'pr' ? <GitPullRequest size={12} /> : <ExternalLink size={12} />}
                  {l.title ?? (l.kind === 'pr' ? `PR ${l.url.split('/').at(-1)}` : l.kind)}
                </a>
              ))}
              {s.subSessions.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Bot size={12} /> {s.subSessions.length} helper {s.subSessions.length === 1 ? 'agent' : 'agents'}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div role="radiogroup" aria-label="What to show" className="flex rounded-md border border-rule bg-surface p-0.5 text-[12.5px]">
            {(['conversation', 'all'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => navigate({ view: v }, { replace: true })}
                className={`rounded px-2 py-1 ${view === v ? 'bg-ink text-paper' : 'text-muted hover:text-ink'}`}
              >
                {v === 'conversation' ? 'Conversation' : 'Everything'}
              </button>
            ))}
          </div>
          <a href={api.exportUrl(sessionId)} download aria-label="Export as Markdown" title="Export as Markdown" className="rounded-md border border-rule bg-surface p-1.5 text-muted hover:text-ink">
            <Download size={15} />
          </a>
        </div>
      </div>
    </header>
  );
}
