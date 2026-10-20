export default {
  ignore: {
    files: ["dist/**"],
  },
  rules: {
    // Its only fix is useMemo, which lint rejects. The React Compiler caches
    // each context value on its inputs (rendering contract 5 in
    // wiki/web-rendering-performance.md), but react-doctor detects the
    // compiler only from Babel setups, not `react({ compiler: true })`.
    "react-doctor/context-provider-value-from-unmemoized-local-literal": "off",
  },
};
