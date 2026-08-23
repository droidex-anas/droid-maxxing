import { useState } from 'react';

import { authorInitials, displayLogin, githubAvatarUrl } from '../lib/prIdentity';

// Real GitHub faces, with initials only as an offline/404 fallback. The failed
// login is tracked (instead of a boolean) so a new author re-tries the image
// without needing a `key` at every call site.
export function GithubAvatar({
  login,
  size = 24,
  className = '',
}: {
  login: string | null;
  size?: number;
  className?: string;
}) {
  const [failedLogin, setFailedLogin] = useState<string | null>(null);
  const src = githubAvatarUrl(login, size);
  const name = displayLogin(login);
  const showImage = src !== null && failedLogin !== login;
  const box = { width: size, height: size };

  return (
    <span
      title={name}
      style={box}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-droid-elevated ring-1 ring-inset ring-droid-text/10 ${className}`}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          style={box}
          className="rounded-full object-cover"
          onError={() => {
            setFailedLogin(login);
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}
          className="font-semibold text-droid-text-secondary"
        >
          {authorInitials(login)}
        </span>
      )}
    </span>
  );
}
