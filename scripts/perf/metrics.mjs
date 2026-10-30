/** A counter may start with historical drift; the run must preserve that
 *  baseline while moving the counter exactly with its underlying rows. */
export function counterDeltaPreserved(beforeCounter, beforeRows, afterCounter, afterRows) {
  return afterCounter - afterRows === beforeCounter - beforeRows
}
