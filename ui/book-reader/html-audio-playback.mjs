// Extracted from Tuba studio/html-audio-playback.ts. Runtime is independent of Tuba.
export class HtmlAudioPlaybackPort {
    #createAudioElement;
    #revokeObjectURL;
    constructor(options = {}) {
        this.#createAudioElement = options.createAudioElement ?? (() => {
            const element = document.createElement("audio");
            element.preload = "auto";
            return element;
        });
        this.#revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    }
    createMedia(input) {
        const element = this.#createAudioElement();
        const blob = new Blob([input.bytes.slice().buffer], { type: input.mimeType });
        const url = URL.createObjectURL(blob);
        element.src = url;
        // Speed changes reuse the same cached audio; pitch stays natural (D04).
        element.playbackRate = input.rate;
        if ("preservesPitch" in element) {
            element.preservesPitch = true;
        }
        const listeners = [];
        const endedListeners = [];
        const errorListeners = [];
        const playingListeners = [];
        const timeUpdateListeners = [];
        const seekingListeners = [];
        const seekedListeners = [];
        const waitingListeners = [];
        let detached = false;
        const add = (target, type, listener) => {
            target.addEventListener(type, listener);
            listeners.push({ target, type, listener });
        };
        const emitError = (kind, message) => {
            if (detached)
                return;
            for (const listener of errorListeners)
                listener({ kind, message });
        };
        const time = () => element.currentTime;
        add(element, "ended", () => {
            if (detached)
                return;
            for (const listener of endedListeners)
                listener();
        });
        add(element, "error", () => {
            if (detached)
                return;
            const mediaError = element.error;
            emitError("decode", mediaError?.message ?? undefined);
        });
        add(element, "playing", () => {
            if (detached)
                return;
            for (const listener of playingListeners)
                listener();
        });
        add(element, "timeupdate", () => {
            if (detached)
                return;
            for (const listener of timeUpdateListeners)
                listener(time());
        });
        add(element, "seeking", () => {
            if (detached)
                return;
            for (const listener of seekingListeners)
                listener(time());
        });
        add(element, "seeked", () => {
            if (detached)
                return;
            for (const listener of seekedListeners)
                listener(time());
        });
        add(element, "waiting", () => {
            if (detached)
                return;
            for (const listener of waitingListeners)
                listener();
        });
        const detach = () => {
            if (detached)
                return;
            detached = true;
            try {
                element.pause();
            }
            catch {
                // Pause of a never-started element is fine to ignore.
            }
            element.removeAttribute("src");
            element.load();
            for (const { target, type, listener } of listeners) {
                target.removeEventListener(type, listener);
            }
            listeners.length = 0;
            this.#revokeObjectURL(url);
        };
        return {
            async play() {
                if (detached)
                    return;
                try {
                    await element.play();
                }
                catch (error) {
                    if (detached)
                        return;
                    const name = error.name;
                    if (name === "NotAllowedError") {
                        emitError("not-allowed", error instanceof Error ? error.message : undefined);
                    }
                    else if (name === "AbortError") {
                        // Superseded or paused mid-start: not a user-facing failure.
                        return;
                    }
                    else {
                        emitError("other", error instanceof Error ? error.message : undefined);
                    }
                    throw error;
                }
            },
            pause() {
                if (detached)
                    return;
                element.pause();
            },
            detach,
            setRate(rate) {
                if (detached)
                    return;
                element.playbackRate = rate;
                if ("preservesPitch" in element) {
                    element.preservesPitch = true;
                }
            },
            get ratePreservesPitch() {
                return true;
            },
            get currentTime() {
                if (detached)
                    return 0;
                return time();
            },
            async seek(seconds, options = {}) {
                if (detached)
                    return;
                const timeoutMs = options.timeoutMs ?? 3000;
                await new Promise((resolve, reject) => {
                    let settled = false;
                    const settle = (error) => {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        element.removeEventListener("seeked", onSeeked);
                        element.removeEventListener("seeking", onSeeking);
                        if (error)
                            reject(error);
                        else
                            resolve();
                    };
                    const onSeeked = () => settle();
                    // Some engines never fire seeked for zero-delta seeks; accept a
                    // settled currentTime within tolerance (§12: 0.05 s).
                    const onSeeking = () => {
                        if (Math.abs(element.currentTime - seconds) <= 0.05)
                            settle();
                    };
                    const timer = setTimeout(() => settle(new Error("seek timed out")), timeoutMs);
                    element.addEventListener("seeked", onSeeked);
                    element.addEventListener("seeking", onSeeking);
                    try {
                        element.currentTime = seconds;
                    }
                    catch (error) {
                        settle(error instanceof Error ? error : new Error("seek failed"));
                    }
                });
            },
            onPlaying(listener) {
                playingListeners.push(listener);
            },
            onTimeUpdate(listener) {
                timeUpdateListeners.push(listener);
            },
            onSeeking(listener) {
                seekingListeners.push(listener);
            },
            onSeeked(listener) {
                seekedListeners.push(listener);
            },
            onWaiting(listener) {
                waitingListeners.push(listener);
            },
            onEnded(listener) {
                endedListeners.push(listener);
            },
            onError(listener) {
                errorListeners.push(listener);
            },
        };
    }
}
