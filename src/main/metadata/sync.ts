import type { Repository } from '../db';
import type { TmdbSyncStatus } from '../../shared/tmdb';
import { createTmdbClient, type TmdbFetch } from './tmdb';

const CONCURRENT_WORKS = 8;
const PROGRESS_INTERVAL_MS = 200;
const RETRY_UNMATCHED_MS = 7 * 24 * 60 * 60 * 1000;

export class TmdbSync {
  private controller: AbortController | null = null;
  private pendingSources = new Set<string>();
  private libraryRequested = false;
  private progress: TmdbSyncStatus = { phase: 'idle', total: 0, matched: 0, unmatched: 0, error: null };

  constructor(
    private readonly repo: Pick<Repository, 'listTmdbWorks' | 'saveTmdbMetadata'>,
    private readonly getCredential: () => string,
    private readonly fetcher: TmdbFetch,
    private readonly onProgress: (status: TmdbSyncStatus) => void,
  ) {}

  get status(): TmdbSyncStatus {
    return this.progress;
  }

  enqueue(sourceId?: string): void {
    if (!this.getCredential()) return;
    if (sourceId) this.pendingSources.add(sourceId);
    else this.libraryRequested = true;
    this.start();
  }

  cancel(): void {
    this.clearQueue();
    this.controller?.abort();
  }

  private clearQueue(): void {
    this.pendingSources.clear();
    this.libraryRequested = false;
  }

  private start(): void {
    if (this.controller) return;
    const credential = this.getCredential();
    if (!credential) return;
    const controller = new AbortController();
    this.controller = controller;
    this.progress = { phase: 'running', total: 0, matched: 0, unmatched: 0, error: null };
    this.onProgress(this.progress);
    void this.run(controller, credential);
  }

  private publish(patch: Partial<TmdbSyncStatus>, notify = true): void {
    this.progress = { ...this.progress, ...patch };
    if (notify) this.onProgress(this.progress);
  }

  private async run(controller: AbortController, credential: string): Promise<void> {
    const { signal } = controller;
    const client = createTmdbClient(credential, this.fetcher);
    const attempted = new Set<string>();
    let lastProgressAt = performance.now();
    let completion: Pick<TmdbSyncStatus, 'phase' | 'error'> = { phase: 'done', error: null };

    try {
      while (this.libraryRequested || this.pendingSources.size > 0) {
        const all = this.libraryRequested;
        const sources = [...this.pendingSources];
        this.clearQueue();
        const retryBefore = all ? Date.now() : Date.now() - RETRY_UNMATCHED_MS;
        const works = this.repo.listTmdbWorks(all ? null : sources, retryBefore).filter((work) => !attempted.has(work.workKey));
        this.publish({ total: this.progress.total + works.length });

        let nextWork = 0;
        const worker = async () => {
          try {
            while (!signal.aborted && nextWork < works.length) {
              const work = works[nextWork++]!;
              const metadata = await client.find(work, signal);
              signal.throwIfAborted();
              this.repo.saveTmdbMetadata(work.workKey, metadata);
              attempted.add(work.workKey);
              const now = performance.now();
              const notify = now - lastProgressAt >= PROGRESS_INTERVAL_MS;
              if (notify) lastProgressAt = now;
              this.publish(metadata
                ? { matched: this.progress.matched + 1 }
                : { unmatched: this.progress.unmatched + 1 }, notify);
            }
          } catch (err) {
            if (!signal.aborted) controller.abort(err);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENT_WORKS, works.length) }, worker));
        signal.throwIfAborted();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        completion = { phase: 'cancelled', error: null };
      } else {
        this.clearQueue();
        completion = { phase: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    }

    this.controller = null;
    this.publish(completion);
    if (this.libraryRequested || this.pendingSources.size > 0) this.start();
  }
}
