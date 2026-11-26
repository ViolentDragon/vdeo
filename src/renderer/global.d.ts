declare global {
  interface Window {
    nebula: {
      channel: Record<string, string>;
      invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
      on<T = unknown>(channel: string, listener: (data: T) => void): () => void;
    };
  }
}

export {};
