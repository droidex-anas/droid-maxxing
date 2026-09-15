interface Destination {
  open(origin?: 'composer' | 'desktop'): void;
  attach(id: string): Promise<void>;
}
let destination: Destination | null = null;

export function bindCaptureDestination(next: Destination): () => void {
  destination = next;
  return () => {
    if (destination === next) destination = null;
  };
}
export function openComposerCapture(origin: 'composer' | 'desktop' = 'composer'): void {
  if (!destination) throw new Error('Open a chat before capturing an attachment');
  destination.open(origin);
}
export async function attachRecentCapture(id: string): Promise<void> {
  if (!destination) throw new Error('Open a chat before attaching a recent capture');
  await destination.attach(id);
}
export function createCaptureGeneration() {
  let generation = 0;
  return {
    stamp: () => generation,
    isCurrent: (stamp: number) => stamp === generation,
    invalidate: () => {
      generation += 1;
    },
  };
}
