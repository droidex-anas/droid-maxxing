import { useRef, useState } from 'react';

import { isGithubAuthCodeCopied } from '../lib/github';

interface GithubAuthCodeCopyResult {
  copiedCode: string | null;
  copyFailedCode: string | null;
}

export function githubAuthCodeCopyResult(
  attempt: number,
  latestAttempt: number,
  authCode: string,
  succeeded: boolean,
): GithubAuthCodeCopyResult | null {
  if (attempt !== latestAttempt) return null;
  return succeeded
    ? { copiedCode: authCode, copyFailedCode: null }
    : { copiedCode: null, copyFailedCode: authCode };
}

export function useGithubAuthCodeCopy(authCode: string | null) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyFailedCode, setCopyFailedCode] = useState<string | null>(null);
  const latestAttempt = useRef(0);

  const copyCode = async () => {
    if (!authCode) return;
    const attempt = latestAttempt.current + 1;
    latestAttempt.current = attempt;
    setCopyFailedCode(null);
    try {
      await navigator.clipboard.writeText(authCode);
      const result = githubAuthCodeCopyResult(attempt, latestAttempt.current, authCode, true);
      if (!result) return;
      setCopiedCode(result.copiedCode);
      setCopyFailedCode(result.copyFailedCode);
    } catch {
      const result = githubAuthCodeCopyResult(attempt, latestAttempt.current, authCode, false);
      if (!result) return;
      setCopiedCode(result.copiedCode);
      setCopyFailedCode(result.copyFailedCode);
    }
  };

  return {
    copied: isGithubAuthCodeCopied(authCode, copiedCode),
    copyFailed: isGithubAuthCodeCopied(authCode, copyFailedCode),
    copyCode,
  };
}
