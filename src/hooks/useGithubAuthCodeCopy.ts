import { useState } from 'react';

import { isGithubAuthCodeCopied } from '../lib/github';

export function useGithubAuthCodeCopy(authCode: string | null) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyFailedCode, setCopyFailedCode] = useState<string | null>(null);

  const copyCode = async () => {
    if (!authCode) return;
    setCopyFailedCode(null);
    try {
      await navigator.clipboard.writeText(authCode);
      setCopiedCode(authCode);
    } catch {
      setCopiedCode(null);
      setCopyFailedCode(authCode);
    }
  };

  return {
    copied: isGithubAuthCodeCopied(authCode, copiedCode),
    copyFailed: isGithubAuthCodeCopied(authCode, copyFailedCode),
    copyCode,
  };
}
