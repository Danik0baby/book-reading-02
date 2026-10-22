import { PDFDataRangeTransport } from "../vendor/pdfjs/6.4.299/pdf.min.mjs";

// Static byte blocks work on Pages without HTTP Range support or a backend.
export async function openPdfSource(manifestUrl) {
    const controller = new AbortController();
    const pending = new Map();
    let stopped = false;
    let rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    // A later network failure can happen while rendering, after startup's race.
    failure.catch(() => {});

    async function fetchChecked(url) {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Не удалось загрузить книгу (HTTP ${response.status}).`);
        return response;
    }

    const response = await fetchChecked(manifestUrl);
    const manifest = await response.json();
    const { length, chunkSize } = manifest;
    if (!Number.isSafeInteger(length) || length < 1 ||
        !Number.isSafeInteger(chunkSize) || chunkSize < 1 ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
        manifest.baseUrl !== `./chunks/${manifest.sha256}/`) {
        throw new Error("Некорректные данные книги. Обновите страницу.");
    }
    const base = new URL(manifest.baseUrl, manifestUrl);

    function getChunk(index) {
        if (pending.has(index)) return pending.get(index);
        const job = fetchChecked(new URL(`${index}.bin`, base)).then(async result => {
            const bytes = new Uint8Array(await result.arrayBuffer());
            const expected = Math.min(chunkSize, length - index * chunkSize);
            if (bytes.byteLength !== expected) throw new Error("Блок книги повреждён или недоступен. Обновите страницу.");
            return bytes;
        });
        pending.set(index, job);
        return job;
    }

    const initialData = await getChunk(0);
    pending.clear();
    class StaticRangeTransport extends PDFDataRangeTransport {
        constructor() {
            // There is no progressive full-file stream; all remaining data is on demand.
            super(length, initialData, true);
        }

        requestDataRange(begin, end) {
            const indexes = [];
            for (let index = Math.floor(begin / chunkSize); index < Math.ceil(end / chunkSize); index++) {
                indexes.push(index);
            }
            Promise.all(indexes.map(getChunk)).then(chunks => {
                if (stopped) return;
                const bytes = new Uint8Array(end - begin);
                chunks.forEach((chunk, i) => {
                    const chunkStart = indexes[i] * chunkSize;
                    const from = Math.max(begin, chunkStart);
                    const to = Math.min(end, chunkStart + chunk.length);
                    bytes.set(chunk.subarray(from - chunkStart, to - chunkStart), from - begin);
                });
                this.onDataRange(begin, bytes);
            }).catch(error => {
                if (stopped) return;
                rejectFailure(error);
                this.onError?.(error);
                this.abort();
            }).finally(() => {
                // PDF.js owns received bytes; don't retain a second full-file cache.
                indexes.forEach(index => pending.delete(index));
            });
        }

        abort() {
            stopped = true;
            controller.abort();
            pending.clear();
        }
    }
    return { range: new StaticRangeTransport(), chunkSize, failure };
}
