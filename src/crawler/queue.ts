export interface QueueItem {
  /** Normalized URL — also the identity of the page. */
  url: string;
  depth: number;
  referrerUrl?: string;
  route: string;
}

/**
 * FIFO frontier for the breadth-first crawl. Remembers every URL ever
 * enqueued or visited and how many URLs were accepted per route pattern,
 * which protects against circular navigation and unbounded pagination.
 */
export class CrawlQueue {
  private readonly items: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private readonly routeCounts = new Map<string, number>();

  constructor(private readonly maxUrlsPerRoute: number) {}

  /** Why an item was refused, or undefined when it was enqueued. */
  enqueue(item: QueueItem): 'already-seen' | 'route-limit' | undefined {
    if (this.seen.has(item.url)) return 'already-seen';
    const count = this.routeCounts.get(item.route) ?? 0;
    if (count >= this.maxUrlsPerRoute) return 'route-limit';
    this.seen.add(item.url);
    this.routeCounts.set(item.route, count + 1);
    this.items.push(item);
    return undefined;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  /** Records a URL reached another way (redirect target, SPA navigation) so it is not visited again. */
  markSeen(url: string): void {
    this.seen.add(url);
  }

  hasSeen(url: string): boolean {
    return this.seen.has(url);
  }

  get size(): number {
    return this.items.length;
  }

  routes(): Map<string, number> {
    return new Map(this.routeCounts);
  }
}
