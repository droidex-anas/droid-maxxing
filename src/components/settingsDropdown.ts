export function focusDropdownOption(option: Pick<HTMLElement, 'focus'> | null | undefined) {
  option?.focus({ preventScroll: true });
}

export function nextDropdownOptionIndex({
  key,
  currentIndex,
  optionCount,
}: {
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
  currentIndex: number;
  optionCount: number;
}): number {
  if (key === 'Home') return 0;
  if (key === 'End') return optionCount - 1;
  if (key === 'ArrowDown') return (currentIndex + 1) % optionCount;
  return (currentIndex - 1 + optionCount) % optionCount;
}
