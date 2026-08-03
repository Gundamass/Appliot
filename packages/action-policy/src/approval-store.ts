export class ApprovalStore {
  private readonly consumed = new Set<string>();

  consume(id: string): boolean {
    if (this.consumed.has(id)) return false;
    this.consumed.add(id);
    return true;
  }
}
