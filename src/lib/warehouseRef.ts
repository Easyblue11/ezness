/**
 * A warehouse file can be copied as a single-line reference token. Pasting it
 * into the composer turns it back into the file's attachment chip instead of
 * inserting the raw text.
 */
const PREFIX = 'ezness-warehouse:';

export function warehouseRefToken(id: string): string {
  return `${PREFIX}${id}`;
}

/** Returns the warehouse item id, or null when the text is ordinary content. */
export function parseWarehouseRef(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  const id = trimmed.slice(PREFIX.length).trim();
  return /^[0-9a-z-]{8,64}$/i.test(id) ? id : null;
}
