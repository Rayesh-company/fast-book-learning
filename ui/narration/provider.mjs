// Extracted from Tuba src/narration/provider.ts; pure algorithms only.
import { NARRATION_PROFILE, PROVIDER_MAX_AUDIO_BYTES, PROVIDER_TIMEOUT_MS, } from "./constants.mjs";
import { DIACRITIZATION_PROFILE, DIACRITIZER_CORRECTIVE_INSTRUCTION, parseDiacritizerResponse } from "./diacritizer.mjs";
import { NarrationApiError } from "./errors.mjs";
import { sha256HexBytes } from "./identity.mjs";
const DIACRITIZER_ENDPOINT = "https://api.avalai.ir/v1/chat/completions";
const DIACRITIZER_MODEL = "deepseek-v4-flash";
const DIACRITIZER_TIMEOUT_MS = 120_000;
const DIACRITIZER_MAX_TEXT_BYTES = 512 * 1024;
const APPROVED_AVALAI_BASE_URLS = new Set([
    "https://api.avalai.ir",
    "https://api.avalapis.ir",
    "https://api.avalai.org",
]);
function isWavSignature(bytes) {
    // Structural check only; the browser performs the full audio decode.
    if (bytes.length < 44)
        return false;
    const header = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
    return header.slice(0, 4) === "RIFF" && header.slice(8, 12) === "WAVE";
}
async function providerErrorDetails(response) {
    const reader = response.body?.getReader();
    if (!reader)
        return "";
    const chunks = [];
    let received = 0;
    while (received < 4096) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (value) {
            chunks.push(value.subarray(0, 4096 - received));
            received += value.byteLength;
        }
    }
    if (received >= 4096)
        void reader.cancel().catch(() => undefined);
    try {
        const payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        if (payload && typeof payload === "object" && "error" in payload) {
            const error = payload.error;
            if (error && typeof error === "object") {
                const details = error;
                return ["code", "type", "message"]
                    .map((key) => details[key])
                    .filter((value) => typeof value === "string")
                    .join(" ");
            }
        }
    }
    catch {
        // Invalid error details do not replace the status-based classification.
    }
    return "";
}
export function createAvalaiSpeechProvider(input = {}) {
    const profile = NARRATION_PROFILE;
    const configuredBaseUrl = input.apiBaseUrl ?? process.env.AVALAI_API_BASE_URL;
    const apiBaseUrl = configuredBaseUrl?.replace(/\/$/u, "");
    if (apiBaseUrl && !APPROVED_AVALAI_BASE_URLS.has(apiBaseUrl)) {
        throw new NarrationApiError("NARRATION_PROVIDER_NOT_CONFIGURED", "Unsupported AvalAI API base URL");
    }
    const endpoint = input.endpoint ?? (apiBaseUrl ? `${apiBaseUrl}/v1/audio/speech` : profile.endpoint);
    const fetchImpl = input.fetchImpl ?? fetch;
    // A dedicated TTS credential takes precedence. The shared key keeps
    // existing local setups usable until AVALAI_TTS_API_KEY is configured.
    const apiKeyReader = input.apiKey ?? (() => process.env.AVALAI_TTS_API_KEY?.trim() || process.env.AVALAI_API_KEY?.trim());
    const timeoutMs = input.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    const maxBytes = input.maxBytes ?? PROVIDER_MAX_AUDIO_BYTES;
    const diacritizerEndpoint = input.diacritizerEndpoint ?? (apiBaseUrl ? `${apiBaseUrl}/v1/chat/completions` : DIACRITIZER_ENDPOINT);
    const diacritizerModel = input.diacritizerModel ?? DIACRITIZER_MODEL;
    const diacritizerTimeoutMs = input.diacritizerTimeoutMs ?? DIACRITIZER_TIMEOUT_MS;
    const maxTextBytes = DIACRITIZER_MAX_TEXT_BYTES;
    return {
        profile,
        availability() {
            if (!apiKeyReader()) {
                return {
                    status: "not-configured",
                    reasonFa: "سرویس ساخت صدا تنظیم نشده است؛ صدای ذخیره‌شده همچنان پخش می‌شود.",
                };
            }
            return { status: "available" };
        },
        async speak(context) {
            if (!context.speechText.trim()) {
                throw new NarrationApiError("NARRATION_INPUT_UNSUPPORTED", "Empty speech text");
            }
            const apiKey = apiKeyReader();
            if (!apiKey) {
                throw new NarrationApiError("NARRATION_PROVIDER_NOT_CONFIGURED", "Neither AVALAI_TTS_API_KEY nor AVALAI_API_KEY is configured in the trusted environment");
            }
            const timeoutController = new AbortController();
            const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
            const signals = [timeoutController.signal];
            if (context.signal)
                signals.push(context.signal);
            const composite = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
            // The abort signal stays armed until the body is fully consumed.
            try {
                const response = await fetchImpl(endpoint, {
                    method: "POST",
                    redirect: "error",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: profile.model,
                        voice: profile.voice,
                        input: context.speechText,
                        response_format: profile.responseFormat,
                    }),
                    signal: composite,
                });
                if (response.status === 402 || response.status === 429) {
                    const details = await providerErrorDetails(response);
                    if (response.status === 402 || /credit|balance|billing|insufficient[_ -]?quota|top.?up/i.test(details)) {
                        throw new NarrationApiError("NARRATION_PROVIDER_CREDIT_EXHAUSTED", "Provider credit exhausted");
                    }
                    const retryAfterHeader = response.headers.get("retry-after");
                    let retryAfterMs;
                    if (retryAfterHeader) {
                        const seconds = Number(retryAfterHeader);
                        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600) {
                            retryAfterMs = Math.round(seconds * 1000);
                        }
                    }
                    throw new NarrationApiError("NARRATION_PROVIDER_RATE_LIMITED", "429 rate limited", retryAfterMs === undefined ? {} : { retryAfterMs });
                }
                if (response.status === 401 || response.status === 403) {
                    throw new NarrationApiError("NARRATION_PROVIDER_AUTH_FAILED", "401/403 auth rejected");
                }
                if (response.status >= 500) {
                    throw new NarrationApiError("NARRATION_PROVIDER_UNAVAILABLE", "5xx provider failure");
                }
                if (response.status === 413) {
                    throw new NarrationApiError("NARRATION_INPUT_UNSUPPORTED", "413: provider rejected the input size");
                }
                if (response.status === 400) {
                    const details = await providerErrorDetails(response);
                    // An input rejection on a paragraph-level speak is the practical
                    // input-too-long signal (doc §9.5); a clearly different cause stays
                    // a generation failure so it never triggers the sentence split.
                    if (!details || /length|too[ _-]?long|token|maximum|limit|exceed/i.test(details)) {
                        throw new NarrationApiError("NARRATION_INPUT_UNSUPPORTED", "400: provider rejected the input size");
                    }
                    throw new NarrationApiError("NARRATION_GENERATION_FAILED", "400: the provider rejected this generation attempt");
                }
                if (response.status !== 200) {
                    throw new NarrationApiError("NARRATION_GENERATION_FAILED", `Unexpected provider status ${response.status}`);
                }
                const contentType = response.headers.get("content-type") ?? "";
                // AvalAI labels this model's RIFF/WAVE response as audio/L16 even
                // with response_format=wav. The WAV signature below is still required.
                if (!/^audio\/(?:wav|x-wav|wave|l16)(?:\s*;|$)/i.test(contentType)) {
                    throw new NarrationApiError("NARRATION_GENERATION_FAILED", `Provider returned a non-audio content type: ${contentType || "empty"}`);
                }
                // Bounded body read also applies to chunked responses without
                // Content-Length; the trusted process never buffers unlimited audio.
                const reader = response.body?.getReader();
                if (!reader) {
                    throw new NarrationApiError("NARRATION_GENERATION_FAILED", "Provider returned an empty body");
                }
                const chunks = [];
                let received = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value) {
                        received += value.byteLength;
                        if (received > maxBytes) {
                            void reader.cancel().catch(() => {
                                // The bounded-read failure is reported below.
                            });
                            throw new NarrationApiError("NARRATION_INPUT_UNSUPPORTED", `Provider body exceeded the ${maxBytes} byte bound`);
                        }
                        chunks.push(value);
                    }
                }
                const bytes = new Uint8Array(received);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                if (bytes.byteLength === 0) {
                    throw new NarrationApiError("NARRATION_GENERATION_FAILED", "Provider returned an empty body");
                }
                if (!isWavSignature(bytes)) {
                    throw new NarrationApiError("NARRATION_GENERATION_FAILED", "Provider response is not a recognizable WAV audio stream");
                }
                return { bytes, sha256: sha256HexBytes(bytes), mimeType: "audio/wav" };
            }
            catch (error) {
                if (error instanceof NarrationApiError)
                    throw error;
                if (composite.aborted) {
                    if (context.signal?.aborted) {
                        throw new NarrationApiError("NARRATION_REQUEST_TIMEOUT", "Narration request was cancelled");
                    }
                    throw new NarrationApiError("NARRATION_REQUEST_TIMEOUT", "Provider request timed out");
                }
                throw new NarrationApiError("NARRATION_PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "transport failure");
            }
            finally {
                clearTimeout(timeout);
            }
        },
        async diacritize(context) {
            // Doc §7: separate job path and timeout from TTS; same key management.
            const apiKey = apiKeyReader();
            if (!apiKey) {
                throw new NarrationApiError("NARRATION_PROVIDER_NOT_CONFIGURED", "Neither AVALAI_TTS_API_KEY nor AVALAI_API_KEY is configured in the trusted environment");
            }
            const timeoutController = new AbortController();
            const timeout = setTimeout(() => timeoutController.abort(), diacritizerTimeoutMs);
            const signals = [timeoutController.signal];
            if (context.signal)
                signals.push(context.signal);
            const composite = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
            try {
                const response = await fetchImpl(diacritizerEndpoint, {
                    method: "POST",
                    redirect: "error",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: diacritizerModel,
                        temperature: DIACRITIZATION_PROFILE.temperature,
                        thinking: DIACRITIZATION_PROFILE.thinking,
                        messages: [
                            { role: "system", content: context.corrective
                                    ? DIACRITIZER_CORRECTIVE_INSTRUCTION
                                    : DIACRITIZATION_PROFILE.systemInstruction },
                            {
                                role: "user",
                                content: JSON.stringify({ id: context.jobRef, text: context.canonicalText }),
                            },
                        ],
                    }),
                    signal: composite,
                });
                if (response.status === 402 || response.status === 429) {
                    const details = await providerErrorDetails(response);
                    if (response.status === 402 || /credit|balance|billing|insufficient/i.test(details)) {
                        throw new NarrationApiError("NARRATION_PROVIDER_CREDIT_EXHAUSTED", "Provider credit exhausted");
                    }
                    throw new NarrationApiError("NARRATION_PROVIDER_RATE_LIMITED", "429 rate limited");
                }
                if (response.status === 401 || response.status === 403) {
                    throw new NarrationApiError("NARRATION_PROVIDER_AUTH_FAILED", "401/403 auth rejected");
                }
                if (response.status >= 500) {
                    throw new NarrationApiError("NARRATION_PROVIDER_UNAVAILABLE", "5xx provider failure");
                }
                if (response.status !== 200) {
                    throw new NarrationApiError("NARRATION_DIACRITIZATION_FAILED", `Unexpected diacritizer status ${response.status}`);
                }
                // Bounded read: a diacritized paragraph is text, bounded far below 1 MiB.
                const reader = response.body?.getReader();
                if (!reader)
                    throw new NarrationApiError("NARRATION_DIACRITIZATION_FAILED", "empty body");
                const chunks = [];
                let received = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value) {
                        received += value.byteLength;
                        if (received > maxTextBytes) {
                            void reader.cancel().catch(() => undefined);
                            throw new NarrationApiError("NARRATION_DIACRITIZATION_FAILED", "body exceeded the text bound");
                        }
                        chunks.push(value);
                    }
                }
                const raw = new TextDecoder().decode(Buffer.concat(chunks));
                let completion;
                try {
                    completion = JSON.parse(raw);
                }
                catch {
                    throw new NarrationApiError("NARRATION_DIACRITIZATION_FAILED", "malformed chat completion envelope");
                }
                const choices = completion && typeof completion === "object" && "choices" in completion
                    ? completion.choices : null;
                const first = Array.isArray(choices) ? choices[0] : null;
                const message = first && typeof first === "object" && "message" in first
                    ? first.message : null;
                const content = message && typeof message === "object" && "content" in message
                    ? message.content : null;
                if (typeof content !== "string") {
                    throw new NarrationApiError("NARRATION_DIACRITIZATION_FAILED", "chat completion has no text message");
                }
                const parsed = parseDiacritizerResponse(content);
                if (!parsed.ok) {
                    throw new NarrationApiError("NARRATION_DIACRITIZATION_FAILED", `malformed response: ${parsed.reason}`);
                }
                return { candidate: parsed.text };
            }
            catch (error) {
                if (error instanceof NarrationApiError)
                    throw error;
                if (composite.aborted) {
                    if (context.signal?.aborted) {
                        throw new NarrationApiError("NARRATION_REQUEST_TIMEOUT", "Diacritization request was cancelled");
                    }
                    throw new NarrationApiError("NARRATION_REQUEST_TIMEOUT", "Diacritizer request timed out");
                }
                throw new NarrationApiError("NARRATION_PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "transport failure");
            }
            finally {
                clearTimeout(timeout);
            }
        },
    };
}
