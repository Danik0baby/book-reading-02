const { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { createHash } = require("node:crypto");

const root = resolve(__dirname, "..");
const pdfjs = join(root, "node_modules/pdfjs-dist");
const { version } = JSON.parse(readFileSync(join(pdfjs, "package.json"), "utf8"));
if (version !== "6.4.299") throw new Error("Update the PDF.js import paths before changing its version.");
const vendor = join(root, "vendor/pdfjs", version);
mkdirSync(vendor, { recursive: true });
for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    copyFileSync(join(pdfjs, "legacy/build", name), join(vendor, name));
}
copyFileSync(join(pdfjs, "LICENSE"), join(vendor, "LICENSE"));
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    cpSync(join(pdfjs, directory), join(vendor, directory), { recursive: true });
}

// Read the source as opaque bytes. Never rewrite or recompress the PDF.
const bytes = readFileSync(join(root, "book/backend.pdf"));
const hash = createHash("sha256").update(bytes).digest("hex");
const chunkSize = 64 * 1024;
const directory = join(root, "book-data/chunks", hash);
mkdirSync(directory, { recursive: true });
for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    writeFileSync(join(directory, `${offset / chunkSize}.bin`), bytes.subarray(offset, offset + chunkSize));
}
writeFileSync(join(root, "book-data/manifest.json"), JSON.stringify({
    length: bytes.length,
    chunkSize,
    sha256: hash,
    baseUrl: `./chunks/${hash}/`
}, null, 2) + "\n");
console.log(`Prepared PDF.js ${version} and ${Math.ceil(bytes.length / chunkSize)} PDF byte blocks. Source PDF unchanged.`);
