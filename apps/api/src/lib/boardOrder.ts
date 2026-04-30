/**
 * Pure helpers for kanban (boardOrder) reordering — extracted from the
 * /deals/:id/move handler so the index math is testable without a database.
 */

/**
 * Given the existing deals in a destination stage (ordered ascending,
 * EXCLUDING the deal being moved), return the new ordering with the moving
 * deal inserted at `requestedPosition`. `requestedPosition` is clamped to
 * [0, destDealIds.length].
 */
export function computeDestinationOrder(
  destDealIds: number[],
  movingId: number,
  requestedPosition: number,
): { targetIndex: number; orderedIds: number[] } {
  const targetIndex = Math.min(Math.max(requestedPosition, 0), destDealIds.length);
  const orderedIds = [
    ...destDealIds.slice(0, targetIndex),
    movingId,
    ...destDealIds.slice(targetIndex),
  ];
  return { targetIndex, orderedIds };
}
