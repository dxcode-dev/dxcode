/** A short, stable hash of text, for cache keys. */
export const textVersion = (value: string) => {
  let hash = 0;
  for (const character of value)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash >>> 0;
};
