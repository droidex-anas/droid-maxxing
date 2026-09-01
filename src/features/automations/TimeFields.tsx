import { useEffect, useRef, useState } from 'react';

const NUMBER_FIELD =
  'h-8 rounded-lg border border-droid-border bg-droid-bg/70 px-2 text-center text-[13px] tabular-nums text-droid-text outline-none transition-colors focus:border-droid-border-hover focus:bg-droid-bg';

export function AutomationTimeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [valueHour, valueMinute] = parseTime(value);
  const [hour, setHour] = useState(String(valueHour).padStart(2, '0'));
  const [minute, setMinute] = useState(String(valueMinute).padStart(2, '0'));
  const minuteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const [nextHour, nextMinute] = parseTime(value);
    setHour(String(nextHour).padStart(2, '0'));
    setMinute(String(nextMinute).padStart(2, '0'));
  }, [value]);

  const commit = (nextHour = hour, nextMinute = minute) => {
    const normalizedHour = clampNumber(nextHour, 0, 23, valueHour);
    const normalizedMinute = clampNumber(nextMinute, 0, 59, valueMinute);
    const formattedHour = String(normalizedHour).padStart(2, '0');
    const formattedMinute = String(normalizedMinute).padStart(2, '0');
    setHour(formattedHour);
    setMinute(formattedMinute);
    onChange(`${formattedHour}:${formattedMinute}`);
  };

  return (
    <div className="inline-flex items-center gap-1.5" role="group" aria-label="Time">
      <input
        value={hour}
        inputMode="numeric"
        aria-label="Hour"
        maxLength={2}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const next = digits(event.target.value, 2);
          setHour(next);
          if (next.length === 2) {
            window.requestAnimationFrame(() => minuteRef.current?.focus());
          }
        }}
        onBlur={() => {
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const delta = event.key === 'ArrowUp' ? 1 : -1;
            const next = wrapNumber(clampNumber(hour, 0, 23, valueHour) + delta, 0, 23);
            commit(String(next), minute);
          } else if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        className={`${NUMBER_FIELD} w-11`}
      />
      <span className="text-[13px] text-droid-text-muted">:</span>
      <input
        ref={minuteRef}
        value={minute}
        inputMode="numeric"
        aria-label="Minute"
        maxLength={2}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setMinute(digits(event.target.value, 2));
        }}
        onBlur={() => {
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const delta = event.key === 'ArrowUp' ? 1 : -1;
            const next = wrapNumber(clampNumber(minute, 0, 59, valueMinute) + delta, 0, 59);
            commit(hour, String(next));
          } else if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        className={`${NUMBER_FIELD} w-11`}
      />
    </div>
  );
}

export function AutomationMinuteInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value).padStart(2, '0'));

  useEffect(() => {
    setText(String(value).padStart(2, '0'));
  }, [value]);

  const commit = (candidate = text) => {
    const next = clampNumber(candidate, 0, 59, value);
    setText(String(next).padStart(2, '0'));
    onChange(next);
  };

  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[12px] text-droid-text-muted">minute</span>
      <input
        value={text}
        inputMode="numeric"
        aria-label="Minute of the hour"
        maxLength={2}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setText(digits(event.target.value, 2));
        }}
        onBlur={() => {
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const delta = event.key === 'ArrowUp' ? 1 : -1;
            commit(String(wrapNumber(clampNumber(text, 0, 59, value) + delta, 0, 59)));
          } else if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        className={`${NUMBER_FIELD} w-12`}
      />
    </div>
  );
}

export function AutomationDateInput({
  value,
  minimum,
  onChange,
}: {
  value: { year: number; month: number; day: number };
  minimum?: { year: number; month: number; day: number };
  onChange: (value: { year: number; month: number; day: number }) => void;
}) {
  const formatted = formatDate(value);
  const [text, setText] = useState(formatted);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(formatDate(value));
  }, [value]);

  const commit = () => {
    const parsed = parseDate(text);
    if (!parsed || (minimum && isCalendarDateBefore(parsed, minimum))) {
      setText(formatDate(value));
      return;
    }
    setText(formatDate(parsed));
    onChange(parsed);
  };

  return (
    <input
      value={text}
      inputMode="numeric"
      aria-label="Date, year month day"
      placeholder="YYYY-MM-DD"
      maxLength={10}
      onFocus={(event) => {
        focused.current = true;
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setText(dateCharacters(event.target.value));
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className={`${NUMBER_FIELD} w-[112px]`}
    />
  );
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [9, 0];
  return [clampNumber(match[1], 0, 23, 9), clampNumber(match[2], 0, 59, 0)];
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, yearText = '', monthText = '', dayText = ''] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1970 ||
    year > 9999 ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatDate(value: { year: number; month: number; day: number }): string {
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

export function isCalendarDateBefore(
  value: { year: number; month: number; day: number },
  minimum: { year: number; month: number; day: number },
): boolean {
  if (value.year !== minimum.year) return value.year < minimum.year;
  if (value.month !== minimum.month) return value.month < minimum.month;
  return value.day < minimum.day;
}

function digits(value: string, maximum: number): string {
  return value.replace(/\D/g, '').slice(0, maximum);
}

function dateCharacters(value: string): string {
  return value.replace(/[^\d-]/g, '').slice(0, 10);
}

export function clampNumber(
  value: string | number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  // `Number('')` is 0, which would silently commit midnight when the user
  // clears the field and blurs instead of restoring the previous value.
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function wrapNumber(value: number, minimum: number, maximum: number): number {
  if (value > maximum) return minimum;
  if (value < minimum) return maximum;
  return value;
}
