/** A single clock seam for records whose timestamps are shown or retained. */
let currentNow: () => Date = () => new Date();

export function now(): Date {
  return currentNow();
}

/** Test hook. Production code always uses the system clock. */
export function setClockForTests(clock?: () => Date): void {
  currentNow = clock ?? (() => new Date());
}
