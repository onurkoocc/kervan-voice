// Conversations are kept in memory by id (SPEC §8). The oldest one is dropped
// once the store is full, so a long-running process stays bounded.

export class ConversationStore<T> {
  private readonly items = new Map<string, T>();

  constructor(
    private readonly create: () => T,
    private readonly maxSize = 10_000,
  ) {}

  get(id: string): T {
    let item = this.items.get(id);
    if (item === undefined) {
      item = this.create();
      if (this.items.size >= this.maxSize) {
        const oldest = this.items.keys().next().value;
        if (oldest !== undefined) this.items.delete(oldest);
      }
      this.items.set(id, item);
    }
    return item;
  }

  get size(): number {
    return this.items.size;
  }
}
