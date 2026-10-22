export function createPageRenderer({ pdf, canvases, getPageWidth, createLinks }) {
    const jobs = new Map();
    const rendered = new Map();
    const queue = [];
    let wanted = new Set();
    let running = 0;

    function scaleFor(page) {
        const base = page.getViewport({ scale: 1 });
        const width = getPageWidth() * Math.min(window.devicePixelRatio || 1, 2);
        // Bound each canvas to 2 megapixels, including high-density phones.
        return Math.min(width / base.width, Math.sqrt(2_000_000 / (base.width * base.height)));
    }

    function release(number, record) {
        record.cancelled = true;
        record.task?.cancel();
        const canvas = canvases[number - 1];
        canvas.width = canvas.height = 0;
        canvas.parentElement.querySelector(".pdf-link-layer")?.remove();
        rendered.delete(number);
        if (!jobs.has(number)) record.page?.cleanup();
    }

    function pump() {
        while (running < 2 && queue.length) {
            const record = queue.shift();
            running++;
            run(record);
        }
    }

    async function run(record) {
        const { number } = record;
        try {
            if (record.cancelled || !wanted.has(number)) return;
            record.page = await pdf.getPage(number);
            if (record.cancelled || !wanted.has(number)) return;
            record.scale = scaleFor(record.page);
            const viewport = record.page.getViewport({ scale: record.scale });
            const canvas = canvases[number - 1];
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            record.task = record.page.render({
                canvasContext: canvas.getContext("2d", { alpha: false }), viewport
            });
            await record.task.promise;
            record.task = null;
            if (record.cancelled || !wanted.has(number)) return;
            rendered.set(number, record);
            record.resolveReady(true);
            // Let the page become visible before extracting text for links.
            await new Promise(resolve => setTimeout(resolve, 0));
            const isActive = () => !record.cancelled && wanted.has(number);
            if (isActive()) {
                try {
                    const layer = await createLinks(record.page, viewport, isActive);
                    if (layer && isActive()) canvas.parentElement.appendChild(layer);
                } catch (error) {
                    console.warn(`Не удалось подготовить ссылки страницы ${number}:`, error);
                }
            }
        } catch (error) {
            if (error.name !== "RenderingCancelledException" && !record.cancelled) {
                record.rejectReady(error);
                record.cancelled = true;
            }
        } finally {
            jobs.delete(number);
            if (record.cancelled || !wanted.has(number)) release(number, record);
            record.resolveReady(false);
            record.resolveDone();
            running--;
            pump();
        }
    }

    function ensure(number) {
        const existing = rendered.get(number);
        if (existing && Math.abs(scaleFor(existing.page) / existing.scale - 1) < 0.2) {
            return Promise.resolve(true);
        }
        if (existing) release(number, existing);
        const pending = jobs.get(number);
        if (pending) {
            return pending.cancelled
                ? pending.done.then(() => wanted.has(number) && ensure(number))
                : pending.ready;
        }
        const record = { number, cancelled: false };
        record.ready = new Promise((resolve, reject) => {
            record.resolveReady = resolve;
            record.rejectReady = reject;
        });
        record.done = new Promise(resolve => { record.resolveDone = resolve; });
        jobs.set(number, record);
        queue.push(record);
        pump();
        return record.ready;
    }

    return {
        setPages(numbers) {
            wanted = new Set(numbers.filter(n => n >= 1 && n <= pdf.numPages));
            for (const [number, record] of new Map([...rendered, ...jobs])) {
                if (!wanted.has(number)) release(number, record);
            }
            return Promise.all([...wanted].map(ensure));
        }
    };
}
