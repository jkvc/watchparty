const REPO_URL = 'https://github.com/jkvc/watchparty';
const SYNCFRAME_URL = 'https://syncframe.jkvc.ai/';

export function Footer({ className = '' }: { className?: string }) {
  return (
    <footer
      className={`flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-faint ${className}`}
    >
      <span>watchparty</span>
      <span aria-hidden className="text-border-strong">
        |
      </span>
      <span>
        open{' '}
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          source
        </a>
      </span>
      <span aria-hidden className="text-border-strong">
        |
      </span>
      <span>
        built with{' '}
        <a
          href={SYNCFRAME_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          syncframe
        </a>
      </span>
    </footer>
  );
}
