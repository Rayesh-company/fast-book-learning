import { emittedPdfTextItems, pdfTextSeparator } from './pdf-text.mjs';
import { indexPdfText } from './pdf-text-index.mjs';

/** One canonical text construction for browser selection and server authority.
 * Separators inspect emitted text: raw producer controls are now spaces, and
 * must not generate an extra separator from their original control glyphs.
 */
export function buildPdfTextIndex(content, pageNumber) {
  const emission = emittedPdfTextItems(content.items.filter(item => 'str' in item), pageNumber);
  const indexItems = emission.map(entry => ({ ...entry.item,
    str: entry.text, selectable: !entry.fromControlMark }));
  return { emission, indexItems, index: indexPdfText({ items: indexItems }, pdfTextSeparator) };
}
