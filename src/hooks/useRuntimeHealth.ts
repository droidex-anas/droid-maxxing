import { useEffect, useState } from 'react';

import { canRunAgents, getRuntimeHealth, subscribeRuntimeHealth } from '../lib/runtimeHealth';
import type { RuntimeHealthSnapshot } from '../lib/runtimeHealth';

export function useRuntimeHealth(): RuntimeHealthSnapshot & { canRunAgents: boolean } {
  const [health, setHealth] = useState(() => ({
    ...getRuntimeHealth(),
    canRunAgents: canRunAgents(),
  }));
  useEffect(() => {
    return subscribeRuntimeHealth(() => {
      setHealth({ ...getRuntimeHealth(), canRunAgents: canRunAgents() });
    });
  }, []);
  return health;
}
