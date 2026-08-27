// One timer per retirement owner, armed only while something is actually
// retirable, so an app with nothing idle has no wakeup at all.
export class RuntimeRetirementTimer {
  private timer?: ReturnType<typeof setTimeout>;
  private due?: number;

  constructor(private readonly onDue: () => void) {}

  armFor(dueAt: number | undefined, now: number): void {
    if (dueAt === undefined) {
      this.cancel();
      return;
    }
    if (this.timer !== undefined && this.due !== undefined && this.due <= dueAt) return;
    this.cancel();
    this.due = dueAt;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.due = undefined;
        this.onDue();
      },
      Math.max(0, dueAt - now),
    );
    this.timer.unref();
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.due = undefined;
  }

  armedFor(): number | undefined {
    return this.due;
  }
}
