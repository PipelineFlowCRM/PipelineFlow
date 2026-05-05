import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// Heuristic: any of these patterns indicates the author meant markdown.
// We deliberately keep this conservative — a stray asterisk in plain text
// shouldn't flip rendering.
const MARKDOWN_PATTERNS: RegExp[] = [
  /^#{1,6}\s/m,                          // ATX headings
  /\*\*[^*\n]+\*\*/,                     // **bold**
  /__[^_\n]+__/,                         // __bold__
  /(?<![\w*])\*[^*\s][^*\n]*[^*\s]\*(?!\w)/, // *italic* (not surrounded by word chars)
  /\[[^\]]+\]\([^\s)]+\)/,               // [text](url)
  /!\[[^\]]*\]\([^\s)]+\)/,              // ![alt](url)
  /`[^`\n]+`/,                           // `inline code`
  /^```/m,                               // ``` fenced code
  /^\s{0,3}[-*+]\s+\S/m,                 // - bullet / * bullet / + bullet
  /^\s{0,3}\d+\.\s+\S/m,                 // 1. ordered list
  /^>\s/m,                               // > blockquote
  /^---+$/m,                             // --- horizontal rule
  /^\|.+\|$/m,                           // | table | row |
  /~~[^~\n]+~~/,                         // ~~strikethrough~~
  /^\s{0,3}[-*+]\s+\[[ xX]\]/m,          // - [ ] / - [x] task list
];

export function isMarkdown(text: string): boolean {
  if (!text) return false;
  return MARKDOWN_PATTERNS.some((p) => p.test(text));
}

export function NoteContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  if (!isMarkdown(content)) {
    return <div className={cn('whitespace-pre-wrap text-sm', className)}>{content}</div>;
  }

  return (
    <div
      className={cn(
        'text-sm leading-relaxed',
        // Tailwind's `prose` plugin isn't installed here, so we style the
        // common markdown elements directly. Keep the cascade tight so notes
        // don't visually overpower the surrounding card chrome.
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold',
        '[&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold',
        '[&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:text-sm [&_h4]:font-semibold',
        '[&_p]:my-1.5',
        '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-0.5',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:no-underline',
        '[&_strong]:font-semibold',
        '[&_em]:italic',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_hr]:my-3 [&_hr]:border-border',
        '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold',
        '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Open links in a new tab and protect against tabnabbing.
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
