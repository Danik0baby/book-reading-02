import * as pdfjsLib from "../vendor/pdfjs/6.4.299/pdf.min.mjs";
import { openPdfSource } from "./pdf-source.js";
import { createPageRenderer } from "./page-renderer.js";
import { createLinkLayer } from "./pdf-links.js";

const runtimeUrl = new URL("../vendor/pdfjs/6.4.299/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", runtimeUrl).href;

export async function startBook() {
    const status = document.getElementById("status");
    const book = document.getElementById("book");
    const counter = document.getElementById("counter");
    const viewer = document.getElementById("viewer");
    const button = id => document.getElementById(id);
    const reportError = error => {
        console.error(error);
        status.textContent = `Не удалось загрузить страницу: ${error.message}`;
    };
    status.textContent = "Загружаю данные книги…";
    // Start the worker download while the manifest and first byte block load.
    const worker = new pdfjsLib.PDFWorker();
    const sourcePromise = openPdfSource(new URL("../book-data/manifest.json", import.meta.url));
    const [source] = await Promise.all([sourcePromise, worker.promise]).catch(error => {
        worker.destroy();
        sourcePromise.then(source => source.range.abort()).catch(() => {});
        throw error;
    });
    const loadingTask = pdfjsLib.getDocument({
        worker,
        range: source.range,
        rangeChunkSize: source.chunkSize,
        disableAutoFetch: true,
        disableStream: true,
        cMapUrl: new URL("cmaps/", runtimeUrl).href,
        standardFontDataUrl: new URL("standard_fonts/", runtimeUrl).href,
        wasmUrl: new URL("wasm/", runtimeUrl).href,
        iccUrl: new URL("iccs/", runtimeUrl).href
    });
    source.range.onError = error => {
        reportError(error);
        loadingTask.destroy().finally(() => worker.destroy()).catch(console.error);
    };
    let pdf;
    try {
        pdf = await Promise.race([loadingTask.promise, source.failure]);
    } catch (error) {
        await loadingTask.destroy();
        worker.destroy();
        throw error;
    }
    status.textContent = "Открываю первые страницы…";

    const canvases = [];
    const pages = [];
    const fragment = document.createDocumentFragment();
    for (let number = 1; number <= pdf.numPages; number++) {
        const page = document.createElement("div");
        page.className = "page";
        page.dataset.pageNumber = number;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 0;
        page.appendChild(canvas);
        fragment.appendChild(page);
        canvases.push(canvas);
        pages.push(page);
    }
    book.appendChild(fragment);
    book.style.pointerEvents = "none";
    const pageFlip = new St.PageFlip(book, {
        width: 550, height: 733, size: "stretch",
        minWidth: 280, maxWidth: 1000, minHeight: 370, maxHeight: 1333,
        showCover: false, drawShadow: true, showPageCorners: true,
        flippingTime: 900, mobileScrollSupport: false, usePortrait: true,
        maxShadowOpacity: 0.85
    });
    pageFlip.loadFromHTML(pages);

    let ready = false;
    let navigating = false;
    let state = "read";
    let transitionPages = [];
    let zoom = 1;
    let soundEnabled = true;
    let sounds;
    let soundIndex = 0;

    const spreadSize = () => pageFlip.getOrientation() === "landscape" ? 2 : 1;
    function spreadAt(index = pageFlip.getCurrentPageIndex()) {
        const size = spreadSize();
        const first = Math.floor(index / size) * size;
        return Array.from({ length: size }, (_, i) => first + i + 1)
            .filter(number => number > 0 && number <= pdf.numPages);
    }
    const renderer = createPageRenderer({
        pdf, canvases,
        getPageWidth: () => (pageFlip.getBoundsRect()?.pageWidth || 550) * zoom,
        createLinks: (page, viewport, isActive) =>
            createLinkLayer(pdf, page, viewport, index => navigate(index), isActive)
    });
    function syncPages() {
        return renderer.setPages([...spreadAt(), ...transitionPages]);
    }
    function updateControls() {
        const index = pageFlip.getCurrentPageIndex();
        counter.textContent = `${index + 1} / ${pdf.numPages}`;
        const busy = !ready || navigating || state !== "read";
        button("first-page").disabled = button("previous-page").disabled = busy || index === 0;
        button("last-page").disabled = button("next-page").disabled = busy || index + spreadSize() >= pdf.numPages;
    }
    function playSound() {
        if (!soundEnabled) return;
        // Don't compete with the first PDF requests for sound downloads.
        sounds ??= Array.from({ length: 3 }, () => {
            const audio = new Audio(new URL("../assets/sounds/turning-a-page.ogg", import.meta.url));
            audio.preload = "none";
            return audio;
        });
        const sound = sounds[soundIndex++ % sounds.length];
        sound.pause();
        sound.currentTime = 0;
        sound.volume = 0.4;
        sound.playbackRate = 0.94 + Math.random() * 0.12;
        sound.play().catch(() => {});
    }

    async function navigate(index, direction = 0) {
        if (!ready || navigating || state !== "read" || index < 0 || index >= pdf.numPages) return;
        navigating = true;
        book.style.pointerEvents = "none";
        updateControls();
        transitionPages = spreadAt(index);
        try {
            await syncPages();
            if (direction > 0) pageFlip.flipNext();
            else if (direction < 0) pageFlip.flipPrev();
            else pageFlip.turnToPage(index);
            if (state === "read") {
                transitionPages = [];
                await syncPages();
            }
        } finally {
            navigating = false;
            book.style.pointerEvents = "";
            updateControls();
        }
    }

    button("first-page").addEventListener("click", () => navigate(0).catch(reportError));
    button("last-page").addEventListener("click", () => navigate(pdf.numPages - 1).catch(reportError));
    button("previous-page").addEventListener("click", () =>
        navigate(pageFlip.getCurrentPageIndex() - spreadSize(), -1).catch(reportError));
    button("next-page").addEventListener("click", () =>
        navigate(pageFlip.getCurrentPageIndex() + spreadSize(), 1).catch(reportError));

    function updateZoom(delta) {
        zoom = Math.min(1.35, Math.max(0.75, zoom + delta));
        book.style.transform = `translateZ(0) scale(${zoom})`;
        syncPages().catch(reportError);
    }
    button("zoom-out").addEventListener("click", () => updateZoom(-0.1));
    button("zoom-in").addEventListener("click", () => updateZoom(0.1));
    button("sound-toggle").addEventListener("click", () => {
        soundEnabled = !soundEnabled;
        if (!soundEnabled) sounds?.forEach(sound => sound.pause());
        button("sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
        button("sound-toggle").title = soundEnabled ? "Выключить звук" : "Включить звук";
        button("sound-toggle").setAttribute("aria-label", button("sound-toggle").title);
    });
    button("fullscreen").addEventListener("click", () => {
        const action = document.fullscreenElement ? document.exitFullscreen() : viewer.requestFullscreen();
        action.catch(reportError);
    });
    document.addEventListener("keydown", event => {
        if (event.target instanceof Element && event.target.closest("button, a, input, textarea, [contenteditable]")) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            button(event.key === "ArrowLeft" ? "previous-page" : "next-page").click();
        }
    });

    // During a drag/corner preview, only the pages taking part in that turn join
    // the visible spread. Drop them again if the reader cancels the gesture.
    pageFlip.on("changeState", event => {
        state = event.data;
        if (state === "flipping") playSound();
        updateControls();
        requestAnimationFrame(() => {
            if (state === "read") {
                transitionPages = [];
            } else {
                const direction = pageFlip.getFlipController().getCalculation()?.getDirection();
                if (direction !== undefined) {
                    const target = pageFlip.getCurrentPageIndex() + (direction === 0 ? 1 : -1) * spreadSize();
                    transitionPages = target >= 0 && target < pdf.numPages ? spreadAt(target) : [];
                }
                // PageFlip clones the DOM for portrait turns; cloneNode omits
                // canvas pixels, so copy the one visible page into that clone.
                for (const page of book.querySelectorAll(".page")) {
                    const sourceCanvas = canvases[Number(page.dataset.pageNumber) - 1];
                    const clone = page.querySelector("canvas");
                    if (clone && clone !== sourceCanvas && sourceCanvas?.width) {
                        clone.width = sourceCanvas.width;
                        clone.height = sourceCanvas.height;
                        clone.getContext("2d").drawImage(sourceCanvas, 0, 0);
                    }
                }
            }
            syncPages().catch(reportError);
        });
    });
    pageFlip.on("flip", () => { updateControls(); syncPages().catch(reportError); });
    pageFlip.on("changeOrientation", () => { transitionPages = []; syncPages().catch(reportError); updateControls(); });
    let resizeTimer;
    function resize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => syncPages().catch(reportError), 150);
    }
    window.addEventListener("resize", resize);
    document.addEventListener("fullscreenchange", () => { pageFlip.update(); resize(); });

    await syncPages();
    ready = true;
    book.style.pointerEvents = "";
    document.querySelectorAll(".toolbar button").forEach(control => { control.disabled = false; });
    updateControls();
    status.textContent = `Готово к чтению · ${pdf.numPages} стр.`;
}
