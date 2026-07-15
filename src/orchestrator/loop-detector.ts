export class LoopDetector {
  private static readonly maxConsecutiveFailures = 3;

  private lastSignature: string | null = null;
  private lastError: string | null = null;
  private repeatCount = 0;

  record(toolName: string, args: Record<string, unknown>, error: string): boolean {
    const signature = `${toolName}:${JSON.stringify(this.sortKeys(args))}`;

    if (signature === this.lastSignature && error === this.lastError) {
      this.repeatCount += 1;
    } else {
      this.repeatCount = 0;
      this.lastSignature = signature;
      this.lastError = error;
    }

    return this.repeatCount >= LoopDetector.maxConsecutiveFailures - 1;
  }

  reset(): void {
    this.lastSignature = null;
    this.lastError = null;
    this.repeatCount = 0;
  }

  private sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
    return Object.keys(obj)
      .sort()
      .reduce((acc: Record<string, unknown>, key) => {
        acc[key] = obj[key];
        return acc;
      }, {});
  }
}
