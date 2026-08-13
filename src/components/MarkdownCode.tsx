import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

const LANGUAGE_LABELS: Record<string, string> = {
  sh: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  zsh: 'Bash',
  console: 'Bash',
  shellsession: 'Bash',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  yml: 'YAML',
  yaml: 'YAML',
  md: 'Markdown',
};

function languageLabel(className?: string): string {
  const match = className?.match(/lang(?:uage)?-([\w+#.-]+)/i);
  if (!match) return 'Code';
  const language = match[1].toLowerCase();
  return LANGUAGE_LABELS[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

export async function copyMarkdownCode(
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
  text: string,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      clearTimeout(timer.current ?? undefined);
    },
    [],
  );
  return (
    <button
      onClick={() => {
        void copyMarkdownCode(navigator.clipboard, text).then((didCopy) => {
          if (!didCopy) return;
          setCopied(true);
          clearTimeout(timer.current ?? undefined);
          timer.current = setTimeout(() => {
            setCopied(false);
          }, 1200);
        });
      }}
      className="flex items-center gap-1 text-[10.5px] text-droid-text-muted hover:text-droid-text transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function CodeCard({
  code,
  className,
  specMode,
  highlighted,
}: {
  code: string;
  className?: string;
  specMode?: boolean;
  highlighted?: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-droid-border overflow-hidden bg-droid-elevated/40 ${specMode ? 'my-4' : 'my-2.5'}`}
    >
      <div className="flex items-center justify-between h-7 px-3 bg-droid-surface/60 border-b border-droid-border">
        <span className="text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
          {languageLabel(className)}
        </span>
        <CodeCopyButton text={code} />
      </div>
      <pre className={`overflow-x-auto ${specMode ? 'p-4' : 'p-3.5'}`}>
        <code
          className={`font-mono leading-[1.65] text-droid-text-secondary whitespace-pre ${specMode ? 'text-[13px]' : 'text-[12px]'}`}
        >
          {highlighted ?? code}
        </code>
      </pre>
    </div>
  );
}
