const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const port = Number(process.env.PORT || 8000);
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf"
};

http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
        response.writeHead(400).end("Bad request");
        return;
    }

    const filePath = path.resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
    }

    fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
            response.writeHead(404).end("Not found");
            return;
        }

        const headers = {
            "Accept-Ranges": "bytes",
            "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream"
        };
        const rangeHeader = request.headers.range;
        if (rangeHeader && path.extname(filePath).toLowerCase() === ".pdf") {
            const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
            if (!match || (!match[1] && !match[2])) {
                response.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` }).end();
                return;
            }

            let start;
            let end;
            if (!match[1]) {
                const suffixLength = Number(match[2]);
                start = Math.max(0, stat.size - suffixLength);
                end = stat.size - 1;
            } else {
                start = Number(match[1]);
                end = match[2] ? Number(match[2]) : stat.size - 1;
            }
            if (start >= stat.size || end < start) {
                response.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` }).end();
                return;
            }

            end = Math.min(end, stat.size - 1);
            response.writeHead(206, {
                ...headers,
                "Content-Length": end - start + 1,
                "Content-Range": `bytes ${start}-${end}/${stat.size}`
            });
            if (request.method === "HEAD") response.end();
            else fs.createReadStream(filePath, { start, end }).pipe(response);
            return;
        }

        response.writeHead(200, { ...headers, "Content-Length": stat.size });
        if (request.method === "HEAD") response.end();
        else fs.createReadStream(filePath).pipe(response);
    });
}).listen(port, "127.0.0.1", () => {
    console.log(`Читальный зал доступен: http://localhost:${port}`);
});
