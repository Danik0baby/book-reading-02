export async function createLinkLayer(pdf, page, viewport, navigate, isActive) {
    const [annotations, text] = await Promise.all([
        page.getAnnotations({ intent: "display" }), page.getTextContent()
    ]);
    if (!isActive()) return null;
    const layer = document.createElement("div");
    layer.className = "pdf-link-layer";
    layer.setAttribute("aria-label", "Ссылки PDF-страницы");
    const destinations = new WeakMap();

    function addLink(rect, url, destination) {
        const [a, b, c, d, e, f] = viewport.transform;
        const corners = [[rect[0], rect[1]], [rect[0], rect[3]],
            [rect[2], rect[1]], [rect[2], rect[3]]]
            .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
        const x1 = Math.min(...corners.map(point => point[0]));
        const y1 = Math.min(...corners.map(point => point[1]));
        const x2 = Math.max(...corners.map(point => point[0]));
        const y2 = Math.max(...corners.map(point => point[1]));
        const link = document.createElement("a");
        link.className = "pdf-link";
        Object.assign(link.style, {
            left: `${Math.min(x1, x2) / viewport.width * 100}%`,
            top: `${Math.min(y1, y2) / viewport.height * 100}%`,
            width: `${Math.abs(x2 - x1) / viewport.width * 100}%`,
            height: `${Math.abs(y2 - y1) / viewport.height * 100}%`
        });
        if (url) {
            link.href = url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = url;
            link.setAttribute("aria-label", `Открыть источник: ${url}`);
        } else {
            link.href = "#";
            link.setAttribute("aria-label", "Перейти к странице книги");
            destinations.set(link, destination);
        }
        layer.appendChild(link);
    }

    for (const annotation of annotations) {
        if (annotation.rect && (annotation.url || annotation.dest)) {
            addLink(annotation.rect, annotation.url, annotation.dest);
        }
    }

    // Also preserve URLs printed as plain text, including wrapped URLs.
    const items = text.items.filter(item => item.str?.trim() && item.width > 0);
    const continuations = new Set();
    for (const item of items) {
        if (continuations.has(item)) continue;
        for (const match of item.str.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
            let url = match[0].replace(/[.,;!?]+$/g, "");
            let last = item;
            const hits = [item];
            while (url.endsWith("-")) {
                let next = null;
                for (const candidate of items) {
                    if (continuations.has(candidate) || hits.includes(candidate) ||
                        Math.abs(candidate.transform[4] - last.transform[4]) >= 4 ||
                        candidate.transform[5] >= last.transform[5] ||
                        last.transform[5] - candidate.transform[5] > Math.max(last.height * 1.8, 20) ||
                        !/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(candidate.str.trim())) continue;
                    if (!next || candidate.transform[5] > next.transform[5]) next = candidate;
                }
                if (!next) break;
                url += next.str.trim();
                hits.push(next);
                continuations.add(next);
                last = next;
            }
            for (const hit of hits) {
                const x = hit.transform[4], y = hit.transform[5];
                addLink([x, y, x + hit.width, y + hit.height], url);
            }
        }
    }

    // One set of handlers per layer; resolve internal destinations only on click.
    for (const name of ["pointerdown", "mousedown", "touchstart"]) {
        layer.addEventListener(name, event => event.stopPropagation());
    }
    layer.addEventListener("click", event => {
        event.stopPropagation();
        const link = event.target.closest("a");
        if (!link || !destinations.has(link)) return;
        event.preventDefault();
        (async () => {
            let destination = destinations.get(link);
            if (typeof destination === "string") destination = await pdf.getDestination(destination);
            if (!Array.isArray(destination) || !destination.length || !isActive()) return;
            const index = typeof destination[0] === "number"
                ? destination[0] : await pdf.getPageIndex(destination[0]);
            if (index >= 0 && index < pdf.numPages) await navigate(index);
        })().catch(error => console.warn("Не удалось открыть ссылку книги:", error));
    });
    return layer.childElementCount ? layer : null;
}
