// Also serialized into WebViews. Keep this comparator self-contained.
export function composerTextMatches(actual: string, expected: string): boolean {
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u200B\uFEFF]/g, '').replace(/\u00a0/g, ' ').trim();
  const left = normalize(actual);
  const right = normalize(expected);
  if (left === right) return true;
  const structured = (text: string) => {
    const starts = Array.from(text.matchAll(/\{\s*"requestId"\s*:/g));
    const start = starts[starts.length - 1]?.index;
    if (start === undefined) return null;
    try {
      const data = JSON.parse(text.slice(start));
      if (typeof data.requestId !== 'string' || !Array.isArray(data.questions)) return null;
      return { instructions: text.slice(0, start).replace(/\s+/g, ''), data: JSON.stringify(data) };
    } catch { return null; }
  };
  const leftParts = structured(left);
  const rightParts = structured(right);
  return Boolean(leftParts && rightParts && leftParts.instructions === rightParts.instructions && leftParts.data === rightParts.data);
}
