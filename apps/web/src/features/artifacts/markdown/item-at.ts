/** `list[index]`, which must exist: a missing item is a bug, so it throws. */
export const itemAt = <T>(list: ArrayLike<T>, index: number): T => {
  const item = list[index];
  if (item === undefined) throw new RangeError(`No item at ${index}`);
  return item;
};
