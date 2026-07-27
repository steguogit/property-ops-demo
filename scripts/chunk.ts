// Simple sentence-aware chunker. Keeps chunks small enough for good retrieval
// while preserving exact phrases. For the demo corpus most docs are short
// enough to be a single chunk, but long sourceText is split here.

export function chunkText(text: string, maxChars = 900, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxChars) return [clean];

  // Split on sentence / paragraph boundaries.
  const parts = clean.split(/(?<=[。．.!?！？\n])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    if ((current + " " + part).length > maxChars && current) {
      chunks.push(current.trim());
      // carry overlap
      const tail = current.slice(Math.max(0, current.length - overlap));
      current = tail + " " + part;
    } else {
      current = current ? current + " " + part : part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
