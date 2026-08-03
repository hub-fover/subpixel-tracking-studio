export async function processCompleteOfflineSequence<T>(
  items: readonly T[],
  process: (item: T, index: number) => Promise<void> | void,
  onFailure: (item: T, index: number, error: unknown) => Promise<void> | void,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  let attempted = 0;
  for (let index = 0; index < items.length && shouldContinue(); index += 1) {
    attempted += 1;
    try {
      await process(items[index], index);
    } catch (error) {
      await onFailure(items[index], index, error);
    }
  }
  return attempted;
}
