export type ProviderMessageRole = 'user' | 'assistant';

export function providerSessionJsonl(
  sessionStart: Record<string, unknown>,
  messageRoles: ProviderMessageRole[] = ['user', 'assistant'],
): string {
  const messages = messageRoles.map((role) => ({
    type: 'message',
    timestamp: '2026-08-09T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text: 'hello' }] },
  }));
  return `${[sessionStart, ...messages].map((line) => JSON.stringify(line)).join('\n')}\n`;
}
