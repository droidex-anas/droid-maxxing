import type { PullRequest } from '../../../types/vcs';

// The Chat button hands the pull request to the prompt bar as an editable
// pre-prompt: the link is typed for the user, who adds what they want done
// before sending. The trailing blank line puts the caret on its own line.
export function prChatSeed(pr: PullRequest): string {
  const title = pr.title.trim();
  const heading = title
    ? `Pull request #${String(pr.number)}: ${title}`
    : `Pull request #${String(pr.number)}`;
  const url = pr.url.trim();
  return `${heading}${url ? `\n${url}` : ''}\n\n`;
}
