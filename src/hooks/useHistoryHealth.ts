import { useEffect, useState } from 'react';

import { getHistoryHealth, subscribeHistoryHealth } from '../lib/historyHealth';
import type { HistoryHealthSnapshot } from '../lib/historyHealth';

export function useHistoryHealth(): HistoryHealthSnapshot {
  const [health, setHealth] = useState(getHistoryHealth);
  useEffect(() => {
    return subscribeHistoryHealth(() => {
      setHealth(getHistoryHealth());
    });
  }, []);
  return health;
}
