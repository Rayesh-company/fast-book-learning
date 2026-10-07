// Extracted from Tuba src/narration/speech-variant.ts; pure algorithms only.
import { validateSpeechVariant } from './diacritizer.mjs';
export function validateVariantForUnit(canonicalText, candidate) {
    const result = validateSpeechVariant(canonicalText, candidate);
    // A structurally valid echo of an unvowelized Persian paragraph is not a
    // usable speech variant. Non-Persian paragraphs need no invented marks.
    if (/[\u0621-\u064A\u0671-\u06D3]/u.test(canonicalText) &&
        (candidate === canonicalText || !/[\u064B-\u0652\u0654\u0670]/u.test(candidate))) {
        return { ok: false, violations: [...result.violations, "persian-text-not-diacritized"] };
    }
    return result;
}
