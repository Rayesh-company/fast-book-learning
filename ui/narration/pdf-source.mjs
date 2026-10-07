/** Trusted PDF authority, sharing exactly the reader's text-emission rules. */
import { readFile } from 'node:fs/promises';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfText } from '../book-reader/pdf-text.mjs';
import { buildPdfTextIndex } from '../book-reader/pdf-content.mjs';
import { pathToFileURL } from 'node:url';

GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

export async function canonicalPdfPage(path, pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new RangeError('Invalid page');
  const bytes = new Uint8Array(await readFile(path));
  const task = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false,
    verbosity: 0, cMapUrl: new URL('../vendor/cmaps/', import.meta.url).pathname,
    cMapPacked: true, standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).pathname });
  try {
    const pdf = await task.promise;
    if (pageNumber > pdf.numPages) throw new RangeError('Invalid page');
    const page = await pdf.getPage(pageNumber);
    return buildPdfTextIndex(await readPdfText(page, OPS.showText), pageNumber).index.text;
  } finally { await task.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const text = await canonicalPdfPage(process.argv[2], Number(process.argv[3]));
    process.stdout.write(JSON.stringify({ ok: true, text }));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false }));
  }
}
