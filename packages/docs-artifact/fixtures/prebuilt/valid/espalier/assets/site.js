const example = document.querySelector("[data-example]");
if (example) example.addEventListener("click", () => example.toggleAttribute("data-active"));
