import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronRight, Download, ExternalLink, GitBranch, GitPullRequest, Info, MessagesSquare, PanelLeft } from 'lucide-react';
import { api, type View } from '../api.ts';
import { navigate, useRoute } from '../router.ts';
import { sideChatLabel } from './SidePanel.tsx';
import { fullDate, plural, projectLabel, projectName, relDate, sourceLabel, tildify, tokens, usd } from '../format.ts';
import { CopyButton, IconButton, Popover, Segmented } from './ui.tsx';

export function SessionHeader({ sessionId, view, onToggleSidebar, sidebarShown }: { sessionId: string; view: View; onToggleSidebar: () => void; sidebarShown: boolean }) {
  const q = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
  const s = q.data;
  const route = useRoute();
  // Sub-agent runs and side chats link back to the chat they came from.
  const sideOf = s?.spawnKind === 'side' ? s.spawnedFromSessionId : undefined;
  const backTo = s?.parentSessionId ?? sideOf;
  const parent = useQuery({ queryKey: ['session', backTo], queryFn: () => api.session(backTo!), enabled: !!backTo });
  const sides = s?.sideChats ?? [];
  const sideOpen = !!route.side;
  const title = s ? s.agentDescription || s.title || s.firstPrompt || 'Untitled chat' : '';
  const meta = s ? [projectLabel(s), sourceLabel(s.sourceId), relDate(s.startedAt)].filter(Boolean).join(' · ') : '';

  return (
    <header className="@container flex h-12 shrink-0 items-center gap-1 border-b border-line bg-canvas pr-2 pl-2 sm:pl-3">
      <span className={sidebarShown ? 'lg:hidden' : ''}>
        <IconButton label="Show sidebar (⌘\)" onClick={onToggleSidebar}>
          <PanelLeft size={16} />
        </IconButton>
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2 px-1">
        {backTo && (
          <button
            type="button"
            onClick={() => navigate({ sessionId: backTo, seq: undefined, side: sideOf ? s!.id : undefined })}
            className="flex max-w-[38%] min-w-0 shrink items-center gap-1 text-[12.5px] text-muted hover:text-ink"
            title={`Back to ${parent.data?.title ?? 'the main chat'}`}
          >
            <span className="truncate">{parent.data?.title ?? 'Main chat'}</span>
            <ChevronRight size={13} className="shrink-0 self-center text-faint" />
          </button>
        )}
        <h1 className="flex min-w-0 shrink items-center gap-1.5 text-[13px] font-semibold tracking-[-0.003em]" title={title}>
          {s?.parentSessionId && <Bot size={14} className="shrink-0 self-center text-muted" />}
          <span className="truncate">{title || '\u00a0'}</span>
        </h1>
        {!backTo && meta && <span className="min-w-[4rem] flex-1 truncate text-[12px] text-faint @max-2xl:hidden">{meta}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Segmented
          label="What to show"
          value={view}
          onChange={(v) => navigate({ view: v }, { replace: true })}
          options={[
            { value: 'conversation', label: <><span className="@2xl:hidden">Chat</span><span className="@max-2xl:hidden">Conversation</span></>, title: 'Prompts, replies and summarised work' },
            { value: 'all', label: <><span className="@2xl:hidden">All</span><span className="@max-2xl:hidden">Everything</span></>, title: 'Also show background records the app added' },
          ]}
        />
        <span className="mx-1.5 h-4 w-px bg-line @max-md:hidden" aria-hidden />
        {sides.length > 0 && (
          <button
            type="button"
            onClick={() => navigate({ side: sideOpen ? undefined : sides.at(-1)!.id }, { replace: true })}
            aria-pressed={sideOpen}
            aria-label={sideOpen ? 'Hide side chats' : `Show ${plural(sides.length, 'side chat')}`}
            title={sideOpen ? 'Hide side chats' : `Side chats: ${sides.map(sideChatLabel).join(', ')}`}
            className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] transition-colors hover:bg-hover hover:text-ink active:bg-press ${sideOpen ? 'bg-hover text-ink' : 'text-muted'}`}
          >
            <MessagesSquare size={15} />
            <span className="tabular-nums">{sides.length}</span>
            <span className="@max-3xl:hidden">{sides.length === 1 ? 'side chat' : 'side chats'}</span>
          </button>
        )}
      {s && (
        <Popover
          label="About this chat"
          trigger={(open, toggle) => (
            <IconButton label="About this chat" onClick={toggle} active={open}>
              <Info size={15} />
            </IconButton>
          )}
        >
          <div className="px-3 pt-2.5 pb-1">
            <div className="text-[12.5px] font-semibold">{title}</div>
          </div>
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 px-3 py-2 text-[12px]">
            <Fact k="Agent">{sourceLabel(s.sourceId)}</Fact>
            <Fact k="Project">
              <button type="button" className="truncate text-left text-accent hover:underline" title={s.projectPath} onClick={() => navigate({ project: s.projectKey, q: undefined }, { replace: true })}>
                {projectName(s.projectPath, s.projectKey)}
              </button>
            </Fact>
            <Fact k="Started">{fullDate(s.startedAt)}</Fact>
            {s.updatedAt !== s.startedAt && <Fact k="Last active">{fullDate(s.updatedAt)}</Fact>}
            <Fact k="Messages">{s.messageCount.toLocaleString()}</Fact>
            {s.models.length > 0 && <Fact k={s.models.length > 1 ? 'Models' : 'Model'}>{s.models.join(', ')}</Fact>}
            {!!s.costUSD && <Fact k="Cost">{usd(s.costUSD)}</Fact>}
            {!!(s.inputTokens || s.outputTokens) && (
              <Fact k="Tokens">
                {tokens(s.inputTokens)} in · {tokens(s.outputTokens)} out
              </Fact>
            )}
            {s.gitBranch && s.gitBranch !== 'HEAD' && (
              <Fact k="Branch">
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranch size={12} className="shrink-0" />
                  <span className="truncate font-mono text-[11px]">{s.gitBranch}</span>
                </span>
              </Fact>
            )}
            {s.links.length > 0 && (
              <Fact k="Links">
                <span className="flex flex-col gap-1">
                  {s.links.map((l) => (
                    <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-accent hover:underline">
                      {l.kind === 'pr' ? <GitPullRequest size={12} className="shrink-0" /> : <ExternalLink size={12} className="shrink-0" />}
                      <span className="truncate">{l.title ?? (l.kind === 'pr' ? `PR ${l.url.split('/').at(-1)}` : l.url)}</span>
                    </a>
                  ))}
                </span>
              </Fact>
            )}
            <Fact k="File">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-[10.5px] text-muted" title={s.filePath}>
                  {tildify(s.filePath)}
                </span>
                <CopyButton text={s.filePath} label="Copy file path" size={13} className="size-5 shrink-0" />
              </span>
            </Fact>
          </dl>
          {s.subSessions.length > 0 && (
            <div className="border-t border-line px-1 pt-1.5 pb-1">
              <div className="px-2 pb-1 text-[11px] font-medium text-faint">{plural(s.subSessions.length, 'helper agent')}</div>
              <div className="scroll-quiet max-h-48 overflow-y-auto">
                {s.subSessions.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => navigate({ sessionId: sub.id, seq: undefined })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-hover"
                  >
                    <Bot size={13} className="shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">{sub.agentDescription || sub.title || 'Helper agent'}</span>
                    <span className="shrink-0 text-[10.5px] text-faint">{plural(sub.messageCount, 'msg')}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Popover>
      )}
        <span className="@max-md:hidden">
          <IconButton label="Export as Markdown" href={api.exportUrl(sessionId)} download>
            <Download size={15} />
          </IconButton>
        </span>
      </div>
    </header>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 truncate text-ink">{children}</dd>
    </>
  );
}
