const status = document.getElementById("status");
document.querySelectorAll(".toolbar button").forEach(button => { button.disabled = true; });
status.textContent = "Открываю книгу…";
performance.mark("book-start");

import("./app.js?v=7")
    .then(({ startBook }) => startBook())
    .then(() => {
        const timing = performance.measure("book-first-spread", "book-start");
        console.info(`Первый разворот готов за ${(timing.duration / 1000).toFixed(2)} с.`);
    })
    .catch(error => {
        console.error("Не удалось открыть книгу:", error);
        status.textContent = `Не удалось открыть книгу: ${error.message}`;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Повторить";
        retry.addEventListener("click", () => window.location.reload());
        status.append(" ", retry);
    });
