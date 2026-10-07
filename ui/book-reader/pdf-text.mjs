// Extracted from Tuba pdf-text.ts. Runtime is independent of Tuba.
/** Preserve multi-character glyphs (e.g. Arabic lam-alef) during RTL reversal. */
export function glyphWordRepairs(runs) {
    const repairs = new Map();
    for (const run of runs) {
        let word = [];
        const flush = () => {
            if (word.some((glyph) => glyph.length > 1)) {
                const reversedGlyphs = [...word].reverse().join("");
                const reversedCharacters = Array.from(word.join("")).reverse().join("");
                if (reversedCharacters !== reversedGlyphs)
                    repairs.set(reversedCharacters, reversedGlyphs);
            }
            word = [];
        };
        for (const glyph of run) {
            if (typeof glyph === "number")
                continue;
            const unicode = glyph && typeof glyph === "object" && "unicode" in glyph ? glyph.unicode : null;
            if (typeof unicode === "string" && /^[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]+$/u.test(unicode))
                word.push(unicode);
            else
                flush();
        }
        flush();
    }
    return repairs;
}
export async function readPdfText(page, showTextOperator) {
    const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
    const runs = operators.argsArray.filter((_args, index) => operators.fnArray[index] === showTextOperator).map((args) => args[0]);
    const repairs = glyphWordRepairs(runs);
    return { ...content, items: content.items.map((item) => "str" in item ? { ...item, str: item.str.replace(/[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]+/gu, (word) => repairs.get(word) ?? word) } : item) };
}
export function pdfTextSeparator(left, right) {
    if (!right)
        return "";
    if (left.hasEOL || !itemsShareBaselineLine(left, right))
        return "\n";
    if (/\s$/u.test(left.str) || /^\s/u.test(right.str))
        return "";
    // Direction-independent glyph-box clearance: mixed-direction lines (digits
    // inside RTL runs) would flip a direction-based gap sign and glue
    // unrelated words together.
    return boxClearance(left, right) > Math.max(left.height, right.height) * 0.08 ? " " : "";
}
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
function isArabicTextItem(item) {
    return item.dir === "rtl" || ARABIC_SCRIPT.test(item.str);
}
/** Producer word marks (e.g. literal BS separators between word items). */
function isControlSeparatorItem(item) {
    return item.str.length > 0 && /^[\u0000-\u001f]+$/u.test(item.str);
}
/**
 * Zero-advance items carry no glyph movement: broken-font letter fragments
 * (Quran quotations) and producer stray spaces inside fragmented words.
 */
function isZeroAdvanceItem(item) {
    return item.width < 0.5;
}
/** True when the item carries usable placement geometry. */
function hasPlacement(item) {
    return typeof item.transform?.[4] === "number" && typeof item.transform[5] === "number";
}
/**
 * Two items share one visual line when their baselines match, or when a
 * zero-advance fragment rides the line it horizontally overlaps — fragmented
 * Quran-font pieces sit several units off the baseline but belong to the word.
 * Items without placement geometry never force a line break (legacy behavior).
 */
function itemsShareBaselineLine(a, b) {
    if (!hasPlacement(a) || !hasPlacement(b))
        return true;
    const delta = Math.abs(a.transform[5] - b.transform[5]);
    const tallest = Math.max(a.height, b.height);
    if (delta <= tallest * 0.5)
        return true;
    return (isZeroAdvanceItem(a) || isZeroAdvanceItem(b)) && delta <= tallest;
}
/** Horizontal distance between two glyph boxes; 0 when they overlap. */
function boxClearance(a, b) {
    if (!hasPlacement(a) || !hasPlacement(b))
        return 0;
    const aLeft = a.transform[4];
    const aRight = aLeft + a.width;
    const bLeft = b.transform[4];
    const bRight = bLeft + b.width;
    return Math.max(0, aLeft - bRight, bLeft - aRight);
}
/** The item-level dominant glyph height, weighted by carried text width. */
function modalGlyphHeight(items) {
    const weights = new Map();
    for (const item of items) {
        if (item.height <= 0)
            continue;
        weights.set(item.height, (weights.get(item.height) ?? 0) + Math.max(item.width, 0) + 1);
    }
    let tallest = 0;
    let winner = 0;
    for (const [height, weight] of weights) {
        if (weight > winner || (weight === winner && height > tallest)) {
            winner = weight;
            tallest = height;
        }
    }
    return tallest;
}
/**
 * Split into lines by clustering baselines globally, top to bottom. Quran
 * quotations share a printed line with the surrounding translation and emit
 * superscript fragments several units off the baseline, so a stream-sequential
 * comparison would let fragment order decide line membership; clustering by
 * proximity keeps every fragment of a printed line together regardless of the
 * order the producer emitted items in.
 */
function groupTextLines(items) {
    const placed = items.filter(hasPlacement);
    if (placed.length === 0)
        return [items];
    const lineReach = Math.max(10, modalGlyphHeight(placed) * 0.85);
    const baselines = [...new Set(placed.map((item) => item.transform[5]))].sort((a, b) => b - a);
    const centers = [];
    for (const y of baselines) {
        const previous = centers.at(-1);
        if (previous === undefined || previous - y > lineReach)
            centers.push(y);
    }
    const lineOf = (item) => {
        const y = item.transform[5];
        let best = 0;
        for (let index = 1; index < centers.length; index += 1) {
            if (Math.abs(centers[index] - y) < Math.abs(centers[best] - y))
                best = index;
        }
        return best;
    };
    const lines = centers.map(() => []);
    const unplaced = [];
    for (const item of items) {
        if (hasPlacement(item))
            lines[lineOf(item)].push(item);
        else
            unplaced.push(item);
    }
    // Anchor-only and geometry-less items keep their stream position relative
    // to the nearest placed item.
    for (const item of unplaced) {
        const index = items.indexOf(item);
        let anchor = index;
        while (anchor >= 0 && !hasPlacement(items[anchor]))
            anchor -= 1;
        const target = anchor >= 0 ? lineOf(items[anchor]) : 0;
        lines[target].push(item);
    }
    return lines.filter((line) => line.length > 0);
}
/**
 * Order a line's items geometrically. Healthy streams are already x-sorted
 * along their reading direction, so this is the identity for them; fragmented
 * Quran-font lines arrive with pieces interleaved out of order and get put
 * back by position. Direction follows the Arabic items' own x trend: when
 * they advance left-to-right in the stream the line is visual (sort
 * right-to-left), otherwise the stream already reads logically. Ties keep
 * stream order.
 */
function orderLineItems(line) {
    if (line.some((item) => !hasPlacement(item)))
        return line;
    const arabic = line.filter(isArabicTextItem);
    let increasing = 0;
    let decreasing = 0;
    for (let i = 1; i < arabic.length; i += 1) {
        const dx = arabic[i].transform[4] - arabic[i - 1].transform[4];
        if (dx > 0.5)
            increasing += 1;
        else if (dx < -0.5)
            decreasing += 1;
    }
    if (!(increasing > 0 && increasing > decreasing))
        return line;
    // Sort by right edge so a word wins its x-tie with the separator glyph at
    // its left edge (reading order puts the word first), then by origin.
    return line
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
        const aRight = a.item.transform[4] + a.item.width;
        const bRight = b.item.transform[4] + b.item.width;
        if (aRight - bRight > 0.5)
            return -1;
        if (bRight - aRight > 0.5)
            return 1;
        const dx = a.item.transform[4] - b.item.transform[4];
        if (dx > 0.5)
            return -1;
        if (dx < -0.5)
            return 1;
        return a.index - b.index;
    })
        .map((entry) => entry.item);
}
/**
 * The emission order shared by plain text and the reader index: lines grouped
 * by baseline (zero-advance fragments stay with the words they overlap),
 * each line ordered geometrically into reading order, with producer control
 * word marks (e.g. literal BS separators) contributing a single space.
 * Zero-advance stray spaces are dropped and whitespace before a combining
 * mark is removed: the fragmented Quran-font quotations emit marks as their
 * own space-separated items, and neither artifact belongs in canonical text.
 */
const REPLACEMENT_CHAR = /\uFFFD/gu;
const SPACE_BEFORE_MARK = /\s+(?=\p{M})/gu;
const DIGIT_RUN = /^[\u0030-\u0039\u0660-\u0669\u06F0-\u06F9]+$/u;
function digitValue(text) {
    if (!DIGIT_RUN.test(text))
        return null;
    let value = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        const digit = code <= 0x39 ? code - 0x30 : code >= 0x6f0 ? code - 0x6f0 : code - 0x660;
        value = value * 10 + digit;
    }
    return value;
}
/** The page's dominant line height, weighted by how much horizontal text
 * each size class actually carries: footnote areas emit many lines and
 * items, so raw counting would let the decoration size win there. */
function pageBodyHeight(lines) {
    const weights = new Map();
    for (const line of lines) {
        let tallest = 0;
        let width = 0;
        for (const item of line) {
            if (item.height > tallest)
                tallest = item.height;
            width += Math.max(item.width, 0);
        }
        if (tallest > 0)
            weights.set(tallest, (weights.get(tallest) ?? 0) + Math.max(width, 1));
    }
    let tallestWinner = 0;
    let winnerWeight = 0;
    for (const [height, weight] of weights) {
        if (weight > winnerWeight || (weight === winnerWeight && height > tallestWinner)) {
            winnerWeight = weight;
            tallestWinner = height;
        }
    }
    return tallestWinner;
}
/** A line set entirely in a smaller size than the body: running heads and
 * footnote blocks sit below the modal body height. */
function isSmallFontLine(line, bodyHeight) {
    if (bodyHeight <= 0)
        return false;
    let seen = 0;
    for (const item of line) {
        if (item.height <= 0)
            continue;
        seen += 1;
        if (item.height >= bodyHeight * 0.85)
            return false;
    }
    return seen > 0;
}
function lineBaseline(line) {
    let lowest = Infinity;
    for (const item of line) {
        const y = item.transform?.[5];
        if (typeof y === "number" && y < lowest)
            lowest = y;
    }
    return lowest;
}
/** Lines that carry real glyphs (producer anchors have zero height). */
function hasGlyphs(line) {
    return line.some((item) => item.height > 0);
}
export function emittedPdfTextItems(items, pageNumber) {
    const emitted = [];
    const lines = groupTextLines(items);
    // Non-body decoration never belongs in the canonical reading text:
    // small-size lines below the body block are the footnote area, a
    // small-size line carrying the page number is the running head, and
    // superscript footnote markers are digit runs far below the body size.
    const bodyHeight = pageBodyHeight(lines);
    let bodyBottom = Infinity;
    for (const line of lines) {
        if (!hasGlyphs(line) || isSmallFontLine(line, bodyHeight))
            continue;
        const baseline = lineBaseline(line);
        if (baseline < bodyBottom)
            bodyBottom = baseline;
    }
    const droppedLines = new Set();
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!isSmallFontLine(line, bodyHeight))
            continue;
        const belowBody = lineBaseline(line) < bodyBottom;
        const runningHead = pageNumber !== undefined
            && line.some((item) => digitValue(item.str) === pageNumber);
        if (belowBody || runningHead)
            droppedLines.add(index);
    }
    for (let index = 0; index < lines.length; index += 1) {
        if (droppedLines.has(index))
            continue;
        let lastKept = null;
        const ordered = orderLineItems(lines[index]);
        for (let i = 0; i < ordered.length; i += 1) {
            const item = ordered[i];
            if (bodyHeight > 0 && DIGIT_RUN.test(item.str) && item.height > 0 && item.height < bodyHeight * 0.75)
                continue;
            // Zero-advance whitespace marks the producer's word gaps: keep it only
            // when the neighboring glyph boxes are actually apart — inside the
            // fragmented Quran-font words the pieces overlap and such a space is a
            // false intra-word break.
            if (/^\s+$/u.test(item.str) && isZeroAdvanceItem(item)) {
                const next = ordered.slice(i + 1).find((candidate) => !(/^\s+$/u.test(candidate.str) && isZeroAdvanceItem(candidate)));
                if (lastKept && next && boxClearance(lastKept, next) <= 0)
                    continue;
            }
            const fromControlMark = isControlSeparatorItem(item);
            const text = fromControlMark ? " " : item.str.replace(REPLACEMENT_CHAR, "").replace(SPACE_BEFORE_MARK, "");
            emitted.push({ item, text, fromControlMark });
            lastKept = item;
        }
    }
    return emitted;
}
export function pdfPlainText(content, pageNumber) {
    const emitted = emittedPdfTextItems(content.items.filter((item) => "str" in item), pageNumber);
    return emitted
        .map((entry, index) => entry.text + pdfTextSeparator(entry.item, emitted[index + 1]?.item))
        .join("")
        .trim();
}
