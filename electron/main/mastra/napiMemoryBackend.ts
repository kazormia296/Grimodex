// Main 専用。renderer の command の契約（electron/shared/ipcContract.ts）には載せない（rendererIsolation の静的試験）。
/** Main-only typed Mastra memory commands exposed by the Native backend. */
export interface NapiMemoryBackendLike {
  memoryEmbedTexts(language: string, texts: string[]): Promise<string>;
  memoryThreadRead(payload: unknown): Promise<string>;
  memoryThreadWrite(payload: unknown): Promise<string>;
  memoryThreadDelete(payload: unknown): Promise<string>;
  memoryMessageRead(payload: unknown): Promise<string>;
  memoryMessageWrite(payload: unknown): Promise<string>;
  memoryMessageDelete(payload: unknown): Promise<string>;
  memoryResourceRead(payload: unknown): Promise<string>;
  memoryResourceWrite(payload: unknown): Promise<string>;
  memoryObservationalMemoryRead(payload: unknown): Promise<string>;
  memoryObservationalMemoryWrite(payload: unknown): Promise<string>;
}

/** Main-only typed Mastra vector commands exposed by the Native backend. */
export interface NapiMemoryVectorBackendLike {
  memoryVectorCreateIndex(indexName: string, dimension: number): Promise<string>;
  memoryVectorUpsert(indexName: string, vectors: unknown): Promise<string>;
  memoryVectorQuery(indexName: string, query: number[], topK: number): Promise<string>;
  memoryVectorListIndexes(): Promise<string>;
  memoryVectorDescribeIndex(indexName: string): Promise<string>;
  memoryVectorDeleteIndex(indexName: string): Promise<string>;
  memoryVectorUpdate(
    indexName: string,
    id: string,
    vector?: number[] | null,
    metadata?: unknown,
  ): Promise<string>;
  memoryVectorDelete(indexName: string, id: string): Promise<string>;
  memoryVectorDeleteMany(indexName: string, ids: unknown): Promise<string>;
}
