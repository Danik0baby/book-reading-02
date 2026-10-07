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
    const linkedContentsPages = new Set();

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

    async function renderRange(firstPage, lastPage) {
        const first = Math.max(1, firstPage);
        const last = Math.min(pdf.numPages, lastPage);
        const jobs = [];
        for (let pageNumber = first; pageNumber <= last; pageNumber++) {
            jobs.push(renderPage(pageNumber));
        }
        await Promise.all(jobs);
    }

    function groupTextRows(items) {
        const rows = [];
        for (const item of items) {
            if (!item.str?.trim() || !item.width) continue;
            const baseline = item.transform[5];
            let row = rows.find(candidate => Math.abs(candidate.baseline - baseline) < 2.5);
            if (!row) {
                row = { baseline, items: [] };
                rows.push(row);
            }
            row.items.push(item);
        }
        for (const row of rows) {
            row.items.sort((a, b) => a.transform[4] - b.transform[4]);
        }
        return rows;
    }

    function getPageNumberFromLabels(label, pageLabels) {
        if (!/^\d+$/.test(label)) return Number(label);
        const labelledIndex = pageLabels?.indexOf(label) ?? -1;
        return labelledIndex >= 0 ? labelledIndex + 1 : Number(label);
    }

    function addContentsLinks(pageNumber, entries) {
        if (linkedContentsPages.has(pageNumber) || entries.length === 0) return;
        const pageElement = book.children[pageNumber - 1];
        const layer = document.createElement("div");
        layer.className = "contents-link-layer";
        layer.setAttribute("aria-label", "Ссылки на страницы книги");

        for (const entry of entries) {
            const link = document.createElement("a");
            link.className = "contents-link";
            link.href = `#page-${entry.destinationPage}`;
            link.title = `Перейти к странице ${entry.label}`;
            link.setAttribute("aria-label", `Перейти к странице ${entry.label}`);
            link.style.left = `${entry.left}%`;
            link.style.top = `${entry.top}%`;
            link.style.width = `${entry.width}%`;
            link.style.height = `${entry.height}%`;

            for (const eventName of ["pointerdown", "mousedown", "touchstart"]) {
                link.addEventListener(eventName, event => event.stopPropagation());
            }
            link.addEventListener("click", async event => {
                event.preventDefault();
                event.stopPropagation();
                await renderRange(entry.destinationPage - 1, entry.destinationPage + 4);
                pageFlip.turnToPage(entry.destinationPage - 1);
                updateCounter();
                prepareAroundCurrentPage().catch(error => {
                    console.error("Не удалось подготовить страницы книги:", error);
                });
            });
            layer.appendChild(link);
        }

        pageElement.appendChild(layer);
        linkedContentsPages.add(pageNumber);
    }

    async function scanForContents() {
        let pageLabels = null;
        try {
            pageLabels = await pdf.getPageLabels();
        } catch (error) {
            console.info("Метки страниц PDF недоступны; использую номера из содержания.");
        }

        const batchSize = 4;
        for (let firstPage = 1; firstPage <= pdf.numPages; firstPage += batchSize) {
            const pageNumbers = Array.from(
                { length: Math.min(batchSize, pdf.numPages - firstPage + 1) },
                (_, index) => firstPage + index
            );
            const results = await Promise.all(pageNumbers.map(async pageNumber => {
                try {
                    const pdfPage = await pdf.getPage(pageNumber);
                    const viewport = pdfPage.getViewport({ scale: 1 });
                    const textContent = await pdfPage.getTextContent();
                    const rows = groupTextRows(textContent.items);
                    const candidates = [];

                    for (const row of rows) {
                        const lineText = row.items.map(item => item.str).join(" ").trim();
                        const pageMatch = lineText.match(/(?:^|\s)(\d{1,4})\s*$/);
                        if (!pageMatch) continue;

                        const label = pageMatch[1];
                        const destinationPage = getPageNumberFromLabels(label, pageLabels);
                        if (!Number.isInteger(destinationPage) || destinationPage < 1 || destinationPage > pdf.numPages) continue;

                        const left = Math.min(...row.items.map(item => item.transform[4]));
                        const right = Math.max(...row.items.map(item => item.transform[4] + item.width));
                        const bottom = Math.min(...row.items.map(item => item.transform[5]));
                        const top = Math.max(...row.items.map(item => item.transform[5] + item.height));
                        const dotCount = (lineText.match(/[.·…]/g) || []).length;
                        const rect = viewport.convertToViewportRectangle([
                            left - 3,
                            bottom - 2,
                            right + 3,
                            top + 2
                        ]);
                        const x = Math.min(rect[0], rect[2]);
                        const y = Math.min(rect[1], rect[3]);
                        const width = Math.abs(rect[2] - rect[0]);
                        const height = Math.abs(rect[3] - rect[1]);
                        candidates.push({
                            label,
                            destinationPage,
                            left: (x / viewport.width) * 100,
                            top: (y / viewport.height) * 100,
                            width: (width / viewport.width) * 100,
                            height: (height / viewport.height) * 100,
                            hasLeader: dotCount >= 5,
                            rightAligned: right >= viewport.width * 0.62
                        });
                    }

                    const leaderRows = candidates.filter(entry => entry.hasLeader).length;
                    const alignedRows = candidates.filter(entry => entry.rightAligned).length;
                    const pageText = textContent.items.map(item => item.str).join(" ").toLowerCase();
                    const hasContentsHeading = /оглавление|краткое содержание|содержание|table\s+of\s+contents|contents/.test(pageText);
                    const looksLikeContents = candidates.length >= 4 && (
                        leaderRows >= 3 ||
                        (hasContentsHeading && alignedRows >= 3) ||
                        (candidates.length >= 7 && alignedRows >= 6)
                    );

                    return looksLikeContents
                        ? { pageNumber, entries: candidates }
                        : null;
                } catch (error) {
                    console.warn(`Не удалось просканировать PDF-страницу ${pageNumber}:`, error);
                    return null;
                }
            }));

            for (const result of results) {
                if (!result) continue;
                addContentsLinks(result.pageNumber, result.entries);
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
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
    scanForContents().catch(error => {
        console.warn("Не удалось найти содержание книги:", error);
    });
}

startBook().catch(error => {
    console.error(error);
    document.getElementById("status").textContent = "Ошибка: " + error.message;
});
