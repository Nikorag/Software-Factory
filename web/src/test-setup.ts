import "@testing-library/jest-dom/vitest";

// jsdom lacks the pointer-capture and scroll APIs that Radix's dropdowns (Select) call.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
