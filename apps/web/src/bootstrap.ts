if (import.meta.env.DEV) await import("./react-scan.dev.js");
if (window.location.pathname === "/") await import("./public-main.js");
else await import("./main-entry.js");
