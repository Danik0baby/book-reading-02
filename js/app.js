import * as pdfjsLib from "../node_modules/pdfjs-dist/build/pdf.mjs";

// Worker paths are resolved relative to index.html.
pdfjsLib.GlobalWorkerOptions.workerSrc =
    "./node_modules/pdfjs-dist/build/pdf.worker.mjs";

async function startBook() {
    let soundEnabled = true;

    // Public-domain recording: Wikimedia Commons, "Turning a page.ogg".
    const pageTurnSounds = Array.from({ length: 3 }, () => {
        const sound = new Audio("./assets/sounds/turning-a-page.ogg");
        sound.preload = "auto";
        sound.volume = 0.42;
        return sound;
    });
    let pageTurnSoundIndex = 0;

    function playPageTurnSound() {
        if (!soundEnabled || pageTurnSounds.length === 0) return;

        const sound = pageTurnSounds[pageTurnSoundIndex];
        pageTurnSoundIndex = (pageTurnSoundIndex + 1) % pageTurnSounds.length;
        sound.pause();
        sound.currentTime = 0;
        sound.playbackRate = 0.94 + Math.random() * 0.12;
        sound.volume = 0.36 + Math.random() * 0.12;
        sound.play().catch(error => {
            console.warn("Не удалось воспроизвести звук страницы:", error);
        });
    }

    // A per-load parameter prevents browsers from reusing a replaced PDF whose
    // preserved modification time is older than the cached version.
    const pdfUrl = new URL("./book/backend.pdf", window.location.href);
    pdfUrl.searchParams.set("reload", Date.now().toString());
    const pdf = await pdfjsLib.getDocument({ url: pdfUrl.href }).promise;
    const status = document.getElementById("status");
    status.textContent = "Подготавливаю первые страницы…";

    const book = document.getElementById("book");
    const canvases = [];

    // Build lightweight page shells; only nearby pages get rasterized.
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const pageElement = document.createElement("div");
        pageElement.className = "page";
        pageElement.dataset.pageNumber = pageNumber;

        const canvas = document.createElement("canvas");
        canvas.width = 0;
        canvas.height = 0;
        pageElement.appendChild(canvas);
        book.appendChild(pageElement);
        canvases.push(canvas);
    }

    const renderedPages = new Set();
    const renderJobs = new Map();
    const linkedPages = new Set();

    async function renderPage(pageNumber) {
        if (renderedPages.has(pageNumber)) return;
        if (renderJobs.has(pageNumber)) return renderJobs.get(pageNumber);

        const job = (async () => {
            const pdfPage = await pdf.getPage(pageNumber);
            const viewport = pdfPage.getViewport({ scale: 1.5 });
            const canvas = canvases[pageNumber - 1];
            const context = canvas.getContext("2d");

            canvas.width = viewport.width;
            canvas.height = viewport.height;
            try {
                await pdfPage.render({ canvasContext: context, viewport }).promise;
                renderedPages.add(pageNumber);
                try {
                    await addPdfLinks(pageNumber, pdfPage, viewport);
                } catch (error) {
                    console.warn(`Не удалось подключить ссылки PDF-страницы ${pageNumber}:`, error);
                }
            } catch (error) {
                canvas.width = 0;
                canvas.height = 0;
                throw error;
            }
        })();

        renderJobs.set(pageNumber, job);
        try {
            await job;
        } finally {
            renderJobs.delete(pageNumber);
        }
    }

    async function addPdfLinks(pageNumber, pdfPage, viewport) {
        if (linkedPages.has(pageNumber)) return;

        const annotations = await pdfPage.getAnnotations({ intent: "display" });
        const links = annotations.filter(annotation =>
            annotation.annotationType === pdfjsLib.AnnotationType.LINK ||
            annotation.subtype === "Link"
        );
        const pageElement = book.children[pageNumber - 1];
        const layer = document.createElement("div");
        layer.className = "pdf-link-layer";
        layer.setAttribute("aria-label", "Ссылки PDF-страницы");

        for (const annotation of links) {
            if (!annotation.rect) continue;
            const [x1, y1, x2, y2] = annotation.rect;
            const [a, b, c, d, e, f] = viewport.transform;
            const corners = [
                [x1, y1], [x1, y2], [x2, y1], [x2, y2]
            ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
            const left = Math.min(...corners.map(point => point[0]));
            const top = Math.min(...corners.map(point => point[1]));
            const width = Math.max(...corners.map(point => point[0])) - left;
            const height = Math.max(...corners.map(point => point[1])) - top;
            const link = document.createElement("a");
            link.className = "pdf-link";
            link.style.left = `${(left / viewport.width) * 100}%`;
            link.style.top = `${(top / viewport.height) * 100}%`;
            link.style.width = `${(width / viewport.width) * 100}%`;
            link.style.height = `${(height / viewport.height) * 100}%`;
            for (const eventName of ["pointerdown", "mousedown", "touchstart"]) {
                link.addEventListener(eventName, event => event.stopPropagation());
            }

            if (annotation.url) {
                link.href = annotation.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.setAttribute("aria-label", annotation.title || "Открыть ссылку из PDF");
            } else if (annotation.dest) {
                let destination = annotation.dest;
                if (typeof destination === "string") {
                    destination = await pdf.getDestination(destination);
                }
                if (!Array.isArray(destination) || destination.length === 0) continue;

                let destinationIndex;
                try {
                    destinationIndex = typeof destination[0] === "number"
                        ? destination[0]
                        : await pdf.getPageIndex(destination[0]);
                } catch (error) {
                    console.warn("Не удалось определить страницу PDF-ссылки:", error);
                    continue;
                }
                const destinationPage = destinationIndex + 1;
                if (destinationPage < 1 || destinationPage > pdf.numPages) continue;

                link.href = `#page-${destinationPage}`;
                link.title = `Перейти к странице ${destinationPage}`;
                link.setAttribute("aria-label", `Перейти к странице ${destinationPage}`);
                link.addEventListener("click", async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    await renderRange(destinationPage - 1, destinationPage + 4);
                    pageFlip.turnToPage(destinationPage - 1);
                    updateCounter();
                    prepareAroundCurrentPage().catch(error => {
                        console.error("Не удалось подготовить страницы книги:", error);
                    });
                });
            } else {
                continue;
            }

            layer.appendChild(link);
        }

        if (layer.childElementCount > 0) pageElement.appendChild(layer);
        linkedPages.add(pageNumber);
    }

    async function renderRange(firstPage, lastPage) {
        const first = Math.max(1, firstPage);
        const last = Math.min(pdf.numPages, lastPage);
        const jobs = [];
        for (let pageNumber = first; pageNumber <= last; pageNumber++) {
            jobs.push(renderPage(pageNumber));
        }
        await Promise.all(jobs);
    }

    function releaseDistantPages(currentPageNumber) {
        const firstKept = Math.max(1, currentPageNumber - 1);
        const lastKept = Math.min(pdf.numPages, currentPageNumber + 5);
        for (const pageNumber of [...renderedPages]) {
            if (pageNumber < firstKept || pageNumber > lastKept) {
                const canvas = canvases[pageNumber - 1];
                canvas.width = 0;
                canvas.height = 0;
                renderedPages.delete(pageNumber);
            }
        }
    }

    // Prepare the opening spread and one spread ahead before first display.
    await renderRange(1, Math.min(pdf.numPages, 4));

    const pageFlip = new St.PageFlip(book, {
        width: 550,
        height: 733,
        size: "stretch",
        minWidth: 280,
        maxWidth: 1000,
        minHeight: 370,
        maxHeight: 1333,
        // Keep sheets flexible so they bend during a turn.
        showCover: false,
        drawShadow: true,
        showPageCorners: true,
        flippingTime: 1_250,
        mobileScrollSupport: false,
        usePortrait: true,
        maxShadowOpacity: 0.85
    });

    pageFlip.loadFromHTML(document.querySelectorAll(".page"));

    const counter = document.getElementById("counter");
    const viewer = document.getElementById("viewer");
    const soundButton = document.getElementById("sound-toggle");
    let zoom = 1;

    async function prepareAroundCurrentPage() {
        const currentPageNumber = pageFlip.getCurrentPageIndex() + 1;
        await renderRange(currentPageNumber - 1, currentPageNumber + 5);
        releaseDistantPages(currentPageNumber);
    }

    function updateCounter() {
        counter.textContent =
            `${pageFlip.getCurrentPageIndex() + 1} / ${pdf.numPages}`;
    }

    function updateZoom(nextZoom) {
        zoom = Math.min(1.35, Math.max(0.75, nextZoom));
        book.style.transform = `translateZ(0) scale(${zoom})`;
    }

    document.getElementById("first-page").addEventListener("click", async () => {
        await renderRange(1, Math.min(pdf.numPages, 2));
        pageFlip.turnToPage(0);
    });

    document.getElementById("previous-page").addEventListener("click", async () => {
        const step = pageFlip.getOrientation() === "landscape" ? 2 : 1;
        const targetIndex = pageFlip.getCurrentPageIndex() - step;
        if (targetIndex < 0) return;
        await renderRange(targetIndex + 1, targetIndex + step + 1);
        pageFlip.flipPrev();
    });

    document.getElementById("next-page").addEventListener("click", async () => {
        const step = pageFlip.getOrientation() === "landscape" ? 2 : 1;
        const targetIndex = pageFlip.getCurrentPageIndex() + step;
        if (targetIndex >= pdf.numPages) return;
        await renderRange(targetIndex + 1, targetIndex + step + 1);
        pageFlip.flipNext();
    });

    document.getElementById("last-page").addEventListener("click", async () => {
        await renderRange(Math.max(1, pdf.numPages - 1), pdf.numPages);
        pageFlip.turnToPage(pdf.numPages - 1);
    });

    document.getElementById("zoom-out").addEventListener("click", () => {
        updateZoom(zoom - 0.1);
    });

    document.getElementById("zoom-in").addEventListener("click", () => {
        updateZoom(zoom + 0.1);
    });

    soundButton.addEventListener("click", () => {
        soundEnabled = !soundEnabled;
        if (!soundEnabled) {
            pageTurnSounds.forEach(sound => {
                sound.pause();
                sound.currentTime = 0;
            });
        }
        soundButton.setAttribute("aria-pressed", String(soundEnabled));
        soundButton.title = soundEnabled ? "Выключить звук" : "Включить звук";
        soundButton.setAttribute("aria-label", soundButton.title);
        soundButton.textContent = soundEnabled ? "♬" : "♩";
    });

    document.getElementById("fullscreen").addEventListener("click", () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            viewer.requestFullscreen();
        }
    });

    document.addEventListener("fullscreenchange", () => {
        pageFlip.update();
    });

    document.addEventListener("keydown", event => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        if (event.key === "ArrowLeft") {
            document.getElementById("previous-page").click();
        }
        if (event.key === "ArrowRight") {
            document.getElementById("next-page").click();
        }
    });

    updateCounter();

    pageFlip.on("changeState", event => {
        if (event.data === "flipping") playPageTurnSound();
    });

    pageFlip.on("flip", () => {
        updateCounter();
        prepareAroundCurrentPage().catch(error => {
            console.error("Не удалось подготовить страницы книги:", error);
        });
    });

    status.textContent = `Готово к чтению · ${pdf.numPages} стр.`;
    prepareAroundCurrentPage().catch(error => {
        console.error("Не удалось подготовить страницы книги:", error);
    });
}

startBook().catch(error => {
    console.error(error);
    document.getElementById("status").textContent = "Ошибка: " + error.message;
});
